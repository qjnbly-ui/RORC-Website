#!/usr/bin/env node

const crypto = require("node:crypto");

const SUPABASE_URL = stripTrailingSlash(process.env.SUPABASE_URL || "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DEFAULT_PASSWORD = process.env.RORC_DEFAULT_AUTH_PASSWORD || "";
const APPLY = process.argv.includes("--apply");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  fail("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.");
}

main().catch((error) => {
  fail(error.message || String(error));
});

async function main() {
  const [members, accounts, authUsers] = await Promise.all([
    readTable("account_members", "id,account_id,member_name,account_type,email_address,phone_number,auth_user_id,is_billing_owner", "member_name.asc"),
    readTable("accounts", "id,account_number", "account_number.asc"),
    listAuthUsers()
  ]);

  const accountNumberById = new Map(accounts.map((account) => [account.id, account.account_number]));
  const existingUserByEmail = new Map(
    authUsers
      .filter((user) => user.email)
      .map((user) => [normalizeEmail(user.email), user])
  );
  const existingUserById = new Map(authUsers.map((user) => [user.id, user]));
  const linkedAuthUserIds = new Set(
    members
      .map((member) => member.auth_user_id)
      .filter(Boolean)
  );

  const eligibleMembers = members
    .map((member) => ({
      ...member,
      normalized_email: normalizeEmail(member.email_address),
      account_number: accountNumberById.get(member.account_id) || ""
    }))
    .sort(compareMembers);

  const emailGroups = groupBy(eligibleMembers.filter((member) => member.normalized_email), "normalized_email");
  const allowedMemberIds = new Set();
  const duplicateSkipped = [];

  for (const group of emailGroups.values()) {
    if (group.length === 1) {
      allowedMemberIds.add(group[0].id);
      continue;
    }

    const accountIds = new Set(group.map((member) => member.account_id));
    if (accountIds.size === 1) {
      const keeper = group.find((member) => member.is_billing_owner) || group[0];
      allowedMemberIds.add(keeper.id);
      group
        .filter((member) => member.id !== keeper.id)
        .forEach((member) => duplicateSkipped.push({ member, keeper }));
      continue;
    }

    group.forEach((member) => duplicateSkipped.push({ member, keeper: null }));
  }

  const summary = {
    dryRun: !APPLY,
    created: 0,
    linkedExisting: 0,
    alreadyLinked: 0,
    updatedLinkedMetadata: 0,
    skippedMissingEmail: 0,
    skippedInvalidEmail: 0,
    skippedDuplicateEmail: duplicateSkipped.length,
    skippedExistingUserAlreadyLinked: 0,
    skippedMissingLinkedAuthUser: 0
  };

  const actions = [];

  for (const member of eligibleMembers) {
    if (member.auth_user_id) {
      const existingUser = existingUserById.get(member.auth_user_id);

      summary.alreadyLinked += 1;
      if (!existingUser) {
        summary.skippedMissingLinkedAuthUser += 1;
        actions.push(formatAction("skip-missing-linked-auth-user", member, member.auth_user_id));
        continue;
      }

      if (APPLY) {
        await updateAuthUser(member.auth_user_id, member, existingUser);
      }

      summary.updatedLinkedMetadata += 1;
      actions.push(formatAction("sync-metadata", member, member.auth_user_id));
      continue;
    }

    if (!member.email_address) {
      summary.skippedMissingEmail += 1;
      continue;
    }

    if (!isValidEmail(member.normalized_email)) {
      summary.skippedInvalidEmail += 1;
      continue;
    }

    if (!allowedMemberIds.has(member.id)) {
      continue;
    }

    const existingUser = existingUserByEmail.get(member.normalized_email);

    if (existingUser) {
      if (linkedAuthUserIds.has(existingUser.id)) {
        summary.skippedExistingUserAlreadyLinked += 1;
        actions.push(formatAction("skip-linked-email", member, existingUser.id));
        continue;
      }

      if (APPLY) {
        await updateAuthUser(existingUser.id, member, existingUser);
        await linkMemberToAuthUser(member.id, existingUser.id);
      }

      linkedAuthUserIds.add(existingUser.id);
      summary.linkedExisting += 1;
      actions.push(formatAction("link-existing", member, existingUser.id));
      continue;
    }

    const createdUser = APPLY ? await createAuthUser(member) : { id: "dry-run-new-user" };

    if (APPLY) {
      await linkMemberToAuthUser(member.id, createdUser.id);
      existingUserByEmail.set(member.normalized_email, createdUser);
      linkedAuthUserIds.add(createdUser.id);
    }

    summary.created += 1;
    actions.push(formatAction("create", member, createdUser.id));
  }

  for (const skipped of duplicateSkipped) {
    actions.push(formatDuplicateSkip(skipped.member, skipped.keeper));
  }

  console.log(JSON.stringify({ summary, actions }, null, 2));

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to create/link users.");
  }
}

async function readTable(table, select, order) {
  const query = new URLSearchParams({ select, order });
  return supabaseFetch(`/rest/v1/${table}?${query.toString()}`);
}

async function listAuthUsers() {
  const users = [];
  const perPage = 1000;
  let page = 1;

  while (true) {
    const data = await supabaseFetch(`/auth/v1/admin/users?page=${page}&per_page=${perPage}`);
    const pageUsers = Array.isArray(data) ? data : data.users || [];
    users.push(...pageUsers);

    if (pageUsers.length < perPage) return users;
    page += 1;
  }
}

async function createAuthUser(member) {
  return supabaseFetch("/auth/v1/admin/users", {
    method: "POST",
    body: {
      email: member.normalized_email,
      password: DEFAULT_PASSWORD || randomPassword(),
      email_confirm: true,
      user_metadata: userMetadata(member),
      app_metadata: appMetadata(member)
    }
  });
}

async function updateAuthUser(userId, member, existingUser) {
  return supabaseFetch(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    body: {
      user_metadata: {
        ...(existingUser.user_metadata || {}),
        ...userMetadata(member)
      },
      app_metadata: {
        ...(existingUser.app_metadata || {}),
        ...appMetadata(member)
      }
    }
  });
}

async function linkMemberToAuthUser(memberId, userId) {
  return supabaseFetch(`/rest/v1/account_members?id=eq.${encodeURIComponent(memberId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { auth_user_id: userId }
  });
}

async function supabaseFetch(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${options.method || "GET"} ${path} failed: ${response.status} ${text}`);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function userMetadata(member) {
  return {
    rorc_account_member_id: member.id,
    rorc_account_id: member.account_id,
    rorc_account_number: member.account_number,
    display_name: member.member_name,
    full_name: member.member_name,
    name: member.member_name,
    member_name: member.member_name,
    email: member.normalized_email || normalizeEmail(member.email_address),
    phone: normalizePhoneForMetadata(member.phone_number),
    phone_number: normalizePhoneForMetadata(member.phone_number),
    account_type: member.account_type,
    is_billing_owner: Boolean(member.is_billing_owner)
  };
}

function appMetadata(member) {
  return {
    rorc_role: member.account_type === "Account Manager" ? "admin" : "member",
    rorc_account_member_id: member.id
  };
}

function compareMembers(a, b) {
  if (a.account_number !== b.account_number) return a.account_number.localeCompare(b.account_number);
  if (a.is_billing_owner !== b.is_billing_owner) return a.is_billing_owner ? -1 : 1;
  return a.member_name.localeCompare(b.member_name);
}

function groupBy(items, key) {
  const groups = new Map();

  for (const item of items) {
    const value = item[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(item);
  }

  return groups;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizePhoneForMetadata(phone) {
  return String(phone || "").trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function randomPassword() {
  return crypto.randomBytes(24).toString("base64url");
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function formatAction(action, member, authUserId) {
  return {
    action,
    memberId: member.id,
    authUserId,
    name: member.member_name,
    email: member.normalized_email,
    accountNumber: member.account_number,
    accountType: member.account_type
  };
}

function formatDuplicateSkip(member, keeper) {
  return {
    action: "skip-duplicate-email",
    memberId: member.id,
    name: member.member_name,
    email: member.normalized_email,
    accountNumber: member.account_number,
    reason: keeper
      ? `Same shared account email; auth user will be linked to ${keeper.member_name}.`
      : "Email is used across multiple accounts; skipped to avoid linking the wrong account."
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
