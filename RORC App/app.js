const appShell = document.querySelector(".app-shell");
const view = document.getElementById("view");
const screenTitle = document.getElementById("screenTitle");
const navControl = document.getElementById("navControl");
const navItems = [...document.querySelectorAll(".nav-item")];
const appDrawer = document.getElementById("appDrawer");
const drawerOverlay = document.getElementById("drawerOverlay");
const drawerItems = [...document.querySelectorAll(".drawer-item")];
const authGate = document.getElementById("authGate");
const appLoginEmail = document.getElementById("appLoginEmail");
const appLoginPassword = document.getElementById("appLoginPassword");
const appLoginButton = document.getElementById("appLoginButton");
const appMagicLinkButton = document.getElementById("appMagicLinkButton");
const appResetPasswordButton = document.getElementById("appResetPasswordButton");
const appAuthMessage = document.getElementById("appAuthMessage");
const appLogoutButton = document.getElementById("appLogoutButton");
const drawerAvatar = document.getElementById("drawerAvatar");
const drawerUserEmail = document.getElementById("drawerUserEmail");
const supabaseSettings = window.RORC_SUPABASE_CONFIG || {};
const STRIPE_FALLBACK_PORTAL = "https://payments.ruthobenchainrc.com/p/login/eVaeWh2tN0vxgSs288";
let supabaseClient = null;
let currentAuthSession = null;
let deferredInstallPrompt = null;
let installFallbackTimer = null;
let appReloadingForUpdate = false;

let accounts = [];
let accountMembers = [];
let globalMemberDirectory = [];
let timesheetEntries = [];
let heaterUseEntries = [];
let billingLineItems = [];
let notificationDispatchRecords = [];
let memberNotifications = [];
let adminNotes = [];
let notificationRealtimeChannel = null;
let notificationRealtimeRetryTimer = null;
let timesheetRealtimeChannel = null;
let timesheetRealtimeRetryTimer = null;
let timesheetSyncInFlight = false;
let timesheetSyncPending = false;
let timesheetSyncNeedsRender = false;
let accountTypeRealtimeChannel = null;
let accountTypeRealtimeRetryTimer = null;
let accountTypeSyncInFlight = false;
let accountTypeSyncPending = false;
let accountTypeSyncNeedsRender = false;
let heaterCountdownTimer = null;
let thermostatStatus = null;
let thermostatStatusFetchedAt = 0;
const THERMOSTAT_STATUS_CACHE_MS = 3 * 60 * 1000;
const pendingHeaterAutoOffIds = new Set();
let thermostatActionFeedback = null;
let notifiedIds = new Set();
let notificationUnreadCount = 0;
let contractReviewPendingCount = 0;
let accountTypePolicies = defaultAccountTypePolicies();
let thermostatSystemAccess = defaultThermostatSystemAccess();
let gymLightsMode = "full";
let gymLightsModeFetchedAt = 0;
let gymLightsModeLoading = false;
let supportsMinorMemberFields = false;

const statusOrder = [
  "Account Manager",
  "Kiosk Account",
  "Special Access Account",
  "Active Membership",
  "Weight Room Only",
  "Open Gym Only",
  "RESTRICTED ACCOUNT"
];

const accountTypeOptions = [
  "Account Manager",
  "Kiosk Account",
  "Special Access Account",
  "Active Membership",
  "Weight Room Only",
  "Open Gym Only",
  "RESTRICTED ACCOUNT"
];

function defaultAccountTypePolicies() {
  return {
    "Account Manager": {
      accountType: "Account Manager",
      canSignIn: true,
      bypassTimeWindows: true,
      allowedDays: [0, 1, 2, 3, 4, 5, 6],
      allowedStartTime: null,
      allowedEndTime: null
    },
    "Kiosk Account": {
      accountType: "Kiosk Account",
      canSignIn: true,
      bypassTimeWindows: true,
      allowedDays: [0, 1, 2, 3, 4, 5, 6],
      allowedStartTime: null,
      allowedEndTime: null
    },
    "Special Access Account": {
      accountType: "Special Access Account",
      canSignIn: true,
      bypassTimeWindows: true,
      allowedDays: [0, 1, 2, 3, 4, 5, 6],
      allowedStartTime: null,
      allowedEndTime: null
    },
    "Active Membership": {
      accountType: "Active Membership",
      canSignIn: true,
      bypassTimeWindows: false,
      allowedDays: [0, 1, 2, 3, 4, 5, 6],
      allowedStartTime: "06:50:00",
      allowedEndTime: "21:10:00"
    },
    "Weight Room Only": {
      accountType: "Weight Room Only",
      canSignIn: true,
      bypassTimeWindows: false,
      allowedDays: [0, 1, 2, 3, 4, 5, 6],
      allowedStartTime: "06:50:00",
      allowedEndTime: "21:10:00"
    },
    "Open Gym Only": {
      accountType: "Open Gym Only",
      canSignIn: true,
      bypassTimeWindows: false,
      allowedDays: [2, 4],
      allowedStartTime: "17:50:00",
      allowedEndTime: "20:10:00"
    },
    "RESTRICTED ACCOUNT": {
      accountType: "RESTRICTED ACCOUNT",
      canSignIn: false,
      bypassTimeWindows: false,
      allowedDays: [],
      allowedStartTime: null,
      allowedEndTime: null
    }
  };
}

function defaultThermostatSystemAccess() {
  return {
    heatEnabled: true,
    acEnabled: true
  };
}

function normalizeThermostatSystemAccess(config) {
  return {
    heatEnabled: config?.heat_enabled !== false,
    acEnabled: config?.ac_enabled !== false
  };
}

function isThermostatSystemEnabled(systemType) {
  return systemType === "ac" ? thermostatSystemAccess.acEnabled : thermostatSystemAccess.heatEnabled;
}

function hasAnyThermostatSystemEnabled() {
  return thermostatSystemAccess.heatEnabled || thermostatSystemAccess.acEnabled;
}


function canonicalAccountType(accountType) {
  const normalized = String(accountType || "").trim().toLowerCase();

  if (!normalized) return "Active Membership";
  if (normalized === "account manager") return "Account Manager";
  if (normalized === "kiosk account") return "Kiosk Account";
  if (normalized === "active membership") return "Active Membership";
  if (normalized === "weight room only") return "Weight Room Only";
  if (normalized === "open gym only") return "Open Gym Only";
  if (normalized === "special access account") return "Special Access Account";
  if (normalized === "restricted account") return "RESTRICTED ACCOUNT";
  if (normalized === "billed monthly") return "Special Access Account";
  if (normalized === "account past due no access allowed") return "RESTRICTED ACCOUNT";

  return String(accountType || "").trim() || "Active Membership";
}

const appState = {
  selectedMemberId: "",
  detailReturnRoute: "accountInfo",
  currentRoute: "currentlySignedIn",
  masterLogsTab: "timesheet",
  masterLogsBillingFilter: "all",
  notificationsHistoryFilter: "all",
  dataStatus: "loading",
  dataError: "",
  authMemberId: "",
  currentUserEmail: "",
  pendingThermostatSystem: ""
};

const accountManagerOnlyRoutes = new Set([
  "accountInfo",
  "gymProjects",
  "advertisementBanners",
  "message",
  "notificationsEmail",
  "masterLogs",
  "messageCompose",
  "contracts",
  "adminNotes"
]);

const kioskAllowedRoutes = new Set([
  "memberSignIn",
  "guestSignIn",
  "currentlySignedIn",
  "heaterRecords",
  "heaterForm",
  "notifications",
  "feedback",
  "calendar",
  "about",
  "share"
]);

let frontDoorSession = buildSession("");
let appUserSession = buildSession("");

const routes = {
  memberSignIn: {
    title: "Member Sign In",
    template: "memberSignInTemplate",
    formRoute: true,
    returnRoute: "currentlySignedIn"
  },
  guestSignIn: {
    title: "Guest Sign In",
    template: "guestSignInTemplate",
    formRoute: true,
    returnRoute: "currentlySignedIn"
  },
  currentlySignedIn: {
    title: "Currently Signed In",
    template: "currentlySignedInTemplate",
    afterRender: renderCurrentlySignedInRoute
  },
  heaterRecords: {
    title: "Thermostat",
    template: "heaterRecordsTemplate",
    afterRender: renderHeaterRecords
  },
  heaterForm: {
    title: "Heater Use",
    template: "heaterFormTemplate",
    formRoute: true,
    returnRoute: "heaterRecords",
    afterRender: populateHeaterForm
  },
  accountInfo: {
    title: "Account Administration",
    template: "accountInfoTemplate",
    afterRender: renderAccountInfo
  },
  accountDetails: {
    title: "Details",
    template: "accountDetailTemplate",
    detailRoute: true,
    afterRender: () => renderAccountDetail(appState.selectedMemberId)
  },
  myAccount: {
    title: "My Account",
    template: "accountDetailTemplate",
    afterRender: () => renderAccountDetail(appUserSession.memberId)
  },
  otherUsers: {
    title: "Other Users On My Account",
    template: "otherUsersTemplate",
    afterRender: renderOtherUsers
  },
  feedback: {
    title: "Feedback",
    template: "feedbackTemplate",
    afterRender: renderFeedbackPage
  },
  calendar: {
    title: "Calendar",
    template: "calendarTemplate"
  },
  gymProjects: {
    title: "Gym Projects",
    template: "placeholderTemplate"
  },
  advertisementBanners: {
    title: "Advertisement Banners",
    template: "placeholderTemplate"
  },
  message: {
    title: "Bot Settings",
    template: "feedbackTemplate",
    afterRender: renderAutomationSettingsPage
  },
  notifications: {
    title: "Notifications",
    template: "feedbackTemplate",
    afterRender: renderUserNotificationsPage
  },
  notificationsEmail: {
    title: "Notifications & Email",
    template: "feedbackTemplate",
    afterRender: renderNotificationsPage
  },
  masterLogs: {
    title: "Master Logs",
    template: "feedbackTemplate",
    afterRender: renderMasterLogsPage
  },
  messageCompose: {
    title: "Message Data Form",
    template: "feedbackTemplate",
    formRoute: true,
    returnRoute: "notificationsEmail",
    afterRender: renderMessageComposerPage
  },
  contracts: {
    title: "Account Reviews",
    template: "feedbackTemplate",
    afterRender: renderContractReviewsPage
  },
  adminNotes: {
    title: "Admin Notes",
    template: "feedbackTemplate",
    afterRender: renderAdminNotesPage
  },
  about: {
    title: "About",
    template: "feedbackTemplate",
    afterRender: renderAboutPage
  },
  share: {
    title: "Share",
    template: "shareTemplate",
    afterRender: renderSharePage
  }
};

function buildSession(memberId) {
  const member = findMember(memberId);

  return {
    memberId,
    memberName: member?.memberName || "",
    accountId: member?.accountId || "",
    accountNumber: displayAccountNumberForMember(member),
    accountType: member?.accountType || ""
  };
}

function findMember(memberId) {
  return accountMembers.find((member) => member.id === memberId)
    || globalMemberDirectory.find((member) => member.id === memberId);
}

function accountForMember(member) {
  return accounts.find((account) => account.id === member?.accountId) || null;
}

function displayAccountNumberForMember(member) {
  if (!member) return "";
  return String(accountForMember(member)?.accountNumber || member.accountNumber || "").trim();
}

function guardianNameForMember(member) {
  if (!member?.guardianMemberId) return "Not set";
  return findMember(member.guardianMemberId)?.memberName || "Not set";
}

function ageFromDateOfBirth(value) {
  if (!value) return "";

  const birthDate = parseDateValue(value);
  if (Number.isNaN(birthDate.getTime())) return "";

  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const birthdayThisYear = new Date(today.getFullYear(), birthDate.getMonth(), birthDate.getDate());

  if (today < birthdayThisYear) {
    age -= 1;
  }

  return age >= 0 ? String(age) : "";
}

function isAccountManager(memberOrSession) {
  return canonicalAccountType(memberOrSession?.accountType) === "Account Manager";
}

function isAccountAdministrationContext() {
  return appState.currentRoute === "accountInfo"
    || (appState.currentRoute === "accountDetails" && appState.detailReturnRoute === "accountInfo");
}

function canUseAccountAdminTools() {
  return Boolean(isAccountManager(appUserSession) && isAccountAdministrationContext());
}

function canUseRecordAdminTools() {
  return Boolean(isAccountManager(appUserSession) && (
    appState.currentRoute === "masterLogs"
    || appState.currentRoute === "heaterRecords"
    || isAccountAdministrationContext()
  ));
}

function isKioskAccount(memberOrSession) {
  return canonicalAccountType(memberOrSession?.accountType) === "Kiosk Account";
}

function isKioskModeSession(memberOrSession) {
  return isKioskAccount(memberOrSession) && String(memberOrSession?.memberName || "").trim().toLowerCase() === "rorc";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function phoneHref(phoneNumber, scheme) {
  const digits = String(phoneNumber || "").replace(/[^\d+]/g, "");
  return digits ? `${scheme}:${digits}` : "";
}

function emailHref(emailAddress, subject = "RORC") {
  const email = String(emailAddress || "").trim();
  return email ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}` : "";
}

function appUrl() {
  const url = new URL("/RORC%20App/", window.location.origin);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function requestedInitialRoute() {
  const routeName = new URLSearchParams(window.location.search).get("route");
  return routes[routeName] ? routeName : "";
}

function dashboardUrl() {
  return new URL("/member-dashboard/", window.location.origin).toString();
}

function installRequestedFromUrl() {
  return new URLSearchParams(window.location.search).get("install") === "1";
}

function cleanInstallUrl() {
  if (!installRequestedFromUrl()) return;

  const url = new URL(window.location.href);
  url.searchParams.delete("install");
  window.history.replaceState({}, "", url.toString());
}

function isAppleTouchDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function showInstallInstructions() {
  cleanInstallUrl();

  if (isAppleTouchDevice()) {
    showInstallSheet({
      title: "Install RORC App",
      message: "On iPhone, tap the Safari Share button, then choose Add to Home Screen.",
      primaryLabel: "Share App",
      primaryAction: shareRorcApp
    });
    return;
  }

  showInstallSheet({
    title: "Install RORC App",
    message: "If your browser does not show an install prompt, use the browser menu and choose Install app or Add to Home screen.",
    primaryLabel: "Share App",
    primaryAction: shareRorcApp
  });
}

function closeInstallSheet() {
  document.querySelector(".app-install-overlay")?.remove();
}

function showInstallSheet({ title, message, primaryLabel, primaryAction }) {
  closeInstallSheet();

  const overlay = document.createElement("div");
  overlay.className = "app-install-overlay";
  overlay.innerHTML = `
    <div class="app-install-card" role="dialog" aria-modal="true" aria-labelledby="appInstallTitle">
      <img src="../Images/LOGOS/LOGO.png" alt="RORC" />
      <p class="eyebrow">Web App</p>
      <h2 id="appInstallTitle">${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="app-install-actions">
        <button class="app-install-secondary" type="button" data-install-close>Not Now</button>
        <button class="app-install-primary" type="button" data-install-primary>${escapeHtml(primaryLabel)}</button>
      </div>
    </div>
  `;

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.closest("[data-install-close]")) {
      cleanInstallUrl();
      closeInstallSheet();
      return;
    }

    if (event.target.closest("[data-install-primary]")) {
      primaryAction?.();
      closeInstallSheet();
    }
  });

  document.body.appendChild(overlay);
}

async function requestAppInstall() {
  if (installFallbackTimer) {
    window.clearTimeout(installFallbackTimer);
    installFallbackTimer = null;
  }

  if (!deferredInstallPrompt) {
    showInstallInstructions();
    return;
  }

  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  cleanInstallUrl();

  promptEvent.prompt();
  await promptEvent.userChoice.catch(() => null);
}

function scheduleInstallRequestIfNeeded() {
  if (!installRequestedFromUrl()) return;

  if (deferredInstallPrompt) {
    showInstallSheet({
      title: "Download RORC App",
      message: "Install the RORC App to your home screen for faster member sign-in, guest sign-in, and heater records.",
      primaryLabel: "Install App",
      primaryAction: requestAppInstall
    });
    return;
  }

  installFallbackTimer = window.setTimeout(() => {
    showInstallInstructions();
  }, 1400);
}

function appShareData() {
  return {
    title: "RORC App",
    text: "Open the Ruth Obenchain Recreation Center member app.",
    url: appUrl()
  };
}

async function shareRorcApp() {
  closeDrawer();

  const shareData = appShareData();

  try {
    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(shareData.url);
      showAppNotice("RORC App link copied.");
      return;
    }

    showAppNotice(`Copy the RORC App link:\n${shareData.url}`);
  } catch (error) {
    if (error?.name === "AbortError") return;
    showAppNotice("Could not open sharing. App link: " + shareData.url);
  }
}

async function copyAppLink() {
  const url = appUrl();

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      setShareStatus("App link copied.");
      return;
    }

    showAppNotice(`Copy the RORC App link:\n${url}`);
    setShareStatus("Copy the app link from the box.");
  } catch (error) {
    showAppNotice(`Copy the RORC App link:\n${url}`);
    setShareStatus("Copy the app link from the box.");
  }
}

function emailAppLink() {
  const subject = "RORC App";
  const body = [
    "Here is the Ruth Obenchain Recreation Center member app:",
    "",
    appUrl(),
    "",
    "Use the same account as your RORC website dashboard."
  ].join("\n");

  window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  setShareStatus("Opening your email app.");
}

async function inviteAccountUser(event) {
  event.preventDefault();

  const form = document.getElementById("shareInviteForm");
  const submitButton = form?.querySelector("button[type='submit']");
  const token = currentAuthSession?.access_token || "";

  if (!form || !token) {
    setShareStatus("Log in again before inviting an account user.");
    return;
  }

  const email = String(document.getElementById("shareInviteEmail")?.value || "").trim().toLowerCase();
  const memberName = String(document.getElementById("shareInviteName")?.value || "").trim();
  const dateOfBirth = String(document.getElementById("shareInviteDob")?.value || "").trim();
  const phoneNumber = String(document.getElementById("shareInvitePhone")?.value || "").trim();

  if (!dateOfBirth) {
    setShareStatus("Enter a date of birth.");
    return;
  }

  const age = Number(ageFromDateOfBirth(dateOfBirth));
  if (!email && !phoneNumber && !(age >= 0 && age < 13)) {
    setShareStatus("Enter an email or phone number for anyone 13 or older.");
    return;
  }

  if (!email && !memberName) {
    setShareStatus("Enter a name for under-13 users without an email.");
    return;
  }

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Inviting...";
  }
  setShareStatus("Creating account user...");

  try {
    const response = await fetch("/api/account-invite", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        email,
        memberName,
        dateOfBirth,
        phoneNumber
      })
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok || body.success === false) {
      throw new Error(body.error || "Could not invite account user.");
    }

    form.reset();
    const deliveryErrors = Array.isArray(body.deliveryErrors) && body.deliveryErrors.length
      ? ` Delivery issue: ${body.deliveryErrors.join(" ")}`
      : "";
    setShareStatus(body.inviteUrl
      ? `${body.message || "Contract invite created."} ${body.inviteUrl}`
      : body.message || "Account user added."
    );
    if (deliveryErrors) {
      setShareStatus(`${document.getElementById("shareStatus")?.textContent || ""}${deliveryErrors}`);
    }
    hydrateFromSupabase().catch((error) => console.warn("Refresh after invite failed.", error));
  } catch (error) {
    setShareStatus(error.message || "Could not invite account user.");
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Create Invite";
    }
  }
}

function setShareStatus(message) {
  const status = document.getElementById("shareStatus");

  if (status) {
    status.textContent = message;
  }
}

function canInviteAccountUsers() {
  const currentMember = findMember(appUserSession.memberId);
  return Boolean(isAccountManager(appUserSession) || currentMember?.isBillingOwner);
}

function canManageBillingForMember(member) {
  const currentMember = findMember(appUserSession.memberId);

  return Boolean(
    member?.accountId
    && (
      isAccountManager(appUserSession)
      || (currentMember?.isBillingOwner && currentMember.accountId === member.accountId)
    )
  );
}

function renderSharePage() {
  const content = document.getElementById("shareContent");
  if (!content) return;

  const inviteAllowed = canInviteAccountUsers();
  const inviteCopy = inviteAllowed
    ? "Users 13 or older receive a contract link first. Under-13 users are added as supervised users without separate login access."
    : "Only account managers or billing owners will be able to invite users to a shared account.";

  content.innerHTML = `
    <div class="share-shell">
      <section class="share-hero">
        <img src="../Images/LOGOS/LOGO.png" alt="RORC" />
        <p class="eyebrow">Web App</p>
        <h2>Share RORC App</h2>
        <p>Send members directly to the installable RORC web app for sign-in, guest entries, heater records, calendar, and account access.</p>
        <div class="share-url-card">
          <code>${escapeHtml(appUrl())}</code>
          <button data-share-action="copy" type="button">Copy</button>
        </div>
      </section>

      <section class="share-action-grid" aria-label="Share app actions">
        <button class="share-action-card" data-share-action="native" type="button">
          <span>Share</span>
          <strong>Share App</strong>
          <small>Open the phone or browser share sheet.</small>
        </button>
        <button class="share-action-card" data-share-action="copy" type="button">
          <span>Copy</span>
          <strong>Copy App Link</strong>
          <small>Copy the app URL to paste anywhere.</small>
        </button>
        <button class="share-action-card" data-share-action="email" type="button">
          <span>Email</span>
          <strong>Email App Link</strong>
          <small>Open a prewritten email with the app link.</small>
        </button>
        <button class="share-action-card" data-share-action="install" type="button">
          <span>Install</span>
          <strong>Download App</strong>
          <small>Show the install prompt or phone instructions.</small>
        </button>
      </section>

      <section class="share-invite-card">
        <div>
          <p class="eyebrow">Account Access</p>
          <h3>Invite User To My Account</h3>
          <p>${escapeHtml(inviteCopy)}</p>
        </div>
        <form id="shareInviteForm" class="share-invite-form" ${inviteAllowed ? "" : 'aria-disabled="true"'}>
          <input id="shareInviteName" type="text" placeholder="Name required for under 13" ${inviteAllowed ? "" : "disabled"} />
          <input id="shareInviteEmail" type="email" placeholder="Email optional if phone is provided" ${inviteAllowed ? "" : "disabled"} />
          <input id="shareInviteDob" type="date" aria-label="Date of birth" ${inviteAllowed ? "required" : "disabled"} />
          <input id="shareInvitePhone" type="tel" placeholder="Phone optional if email is provided" ${inviteAllowed ? "" : "disabled"} />
          <button type="submit" ${inviteAllowed ? "" : "disabled"}>${inviteAllowed ? "Create Invite" : "Locked"}</button>
        </form>
      </section>

      <p id="shareStatus" class="share-status" aria-live="polite"></p>
    </div>
  `;

  bindSharePageActions();
}

function renderAboutPage() {
  const root = document.getElementById("feedbackContent");

  if (!root) return;

  root.innerHTML = `
    <section class="about-app-shell">
      <header class="about-app-hero">
        <img src="../Images/LOGOS/LOGO.png" alt="RORC" />
        <p class="eyebrow">Ruth Obenchain Recreation Center</p>
        <h2>About RORC</h2>
        <p>RORC is a community-operated gym in Bly, Oregon. This app supports member sign-in, guest access, heater records, account information, and calendar updates.</p>
      </header>

      <section class="about-app-grid" aria-label="About RORC details">
        <article class="about-app-card">
          <span>History</span>
          <h3>Built for Community Use</h3>
          <p>The facility has served as a local space where families, teams, and community groups can gather, stay active, and host events.</p>
        </article>
        <article class="about-app-card">
          <span>Operations</span>
          <h3>Membership and Events</h3>
          <p>Members use this app for sign-ins and account tools, while the website provides rentals, projects, and support pages for facility operations.</p>
        </article>
        <article class="about-app-card">
          <span>Location</span>
          <h3>Bly, Oregon</h3>
          <p>RORC is managed by the Bly Community Action Team and serves residents and visitors through open gym nights, contracts, and community programming.</p>
        </article>
      </section>

      <section class="about-app-links">
        <button class="about-app-link-card" data-about-action="website" type="button">
          <span>Visit</span>
          <strong>RORC Website</strong>
          <small>Open the main website homepage.</small>
        </button>
        <button class="about-app-link-card" data-about-action="fullAbout" type="button">
          <span>Read</span>
          <strong>Full About Page</strong>
          <small>View the complete RORC history and story page.</small>
        </button>
        <button class="about-app-link-card" data-about-action="support" type="button">
          <span>Contact</span>
          <strong>Support Page</strong>
          <small>Get contact details for memberships and facility questions.</small>
        </button>
      </section>

      <p class="about-app-credit">Built and maintained by <a href="https://n3xra.com" target="_blank" rel="noopener">N3XRA</a></p>
    </section>
  `;

  bindAboutPageActions();
}

function renderFeedbackPage() {
  const root = document.getElementById("feedbackContent");
  const member = findMember(appUserSession.memberId);
  const account = member ? accountForMember(member) : null;

  if (!root) return;

  root.innerHTML = `
    <section class="feedback-shell">
      <header class="feedback-hero">
        <p class="eyebrow">RORC App</p>
        <h2>Feedback</h2>
        <p>Share bugs, ideas, and requests. Your message will be emailed to the RORC app inbox.</p>
      </header>

      <form id="feedbackForm" class="feedback-form">
        <input id="feedbackMemberName" type="hidden" value="${escapeAttribute(member?.memberName || "")}" />
        <input id="feedbackAccountNumber" type="hidden" value="${escapeAttribute(displayAccountNumberForMember(member))}" />

        <label>
          <span>Type</span>
          <select id="feedbackType">
            <option value="Bug Report">Bug Report</option>
            <option value="Feature Request">Feature Request</option>
            <option value="Usability">Usability</option>
            <option value="General" selected>General</option>
          </select>
        </label>

        <label>
          <span>Subject (optional)</span>
          <input id="feedbackSubject" type="text" maxlength="120" />
        </label>

        <label>
          <span>Message</span>
          <textarea id="feedbackMessage" rows="6" maxlength="4000" required></textarea>
        </label>

        <div class="feedback-actions">
          <button id="feedbackSubmit" type="submit">Send Feedback</button>
          <p id="feedbackResult" class="feedback-result" aria-live="polite"></p>
        </div>
      </form>
    </section>
  `;

  bindFeedbackActions();
}

function setFeedbackResult(message, tone = "default") {
  const result = document.getElementById("feedbackResult");
  if (!result) return;
  result.textContent = message;
  result.dataset.tone = tone;
}

async function submitFeedback(event) {
  event.preventDefault();

  const submitButton = document.getElementById("feedbackSubmit");
  const feedbackType = String(document.getElementById("feedbackType")?.value || "General").trim();
  const subject = String(document.getElementById("feedbackSubject")?.value || "").trim();
  const message = String(document.getElementById("feedbackMessage")?.value || "").trim();
  const memberName = String(document.getElementById("feedbackMemberName")?.value || "").trim();
  const accountNumber = String(document.getElementById("feedbackAccountNumber")?.value || "").trim();
  const token = currentAuthSession?.access_token || "";

  if (!message) {
    setFeedbackResult("Please enter a message before sending.", "error");
    return;
  }

  if (!token) {
    setFeedbackResult("Your session expired. Please sign in again.", "error");
    return;
  }

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Sending...";
  }
  setFeedbackResult("Sending feedback...");

  try {
    const response = await fetch("/api/app-feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        feedbackType,
        subject,
        message,
        memberName,
        accountNumber
      })
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok || body.success === false) {
      throw new Error(body.error || "Could not send feedback.");
    }

    const messageInput = document.getElementById("feedbackMessage");
    const subjectInput = document.getElementById("feedbackSubject");
    if (messageInput) messageInput.value = "";
    if (subjectInput) subjectInput.value = "";
    setFeedbackResult("Feedback sent. Thank you.", "success");
  } catch (error) {
    setFeedbackResult(error.message || "Could not send feedback.", "error");
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Send Feedback";
    }
  }
}

function bindFeedbackActions() {
  const form = document.getElementById("feedbackForm");
  if (!form) return;
  form.addEventListener("submit", submitFeedback);
}

async function loadAutomationSettings() {
  const token = currentAuthSession?.access_token || "";
  const response = await fetch("/api/automation-settings", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not load automation settings.");
  }

  return body.settings || {};
}

async function saveAutomationSettings(settings) {
  const token = currentAuthSession?.access_token || "";
  const response = await fetch("/api/automation-settings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ settings })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not save automation settings.");
  }
}

async function loadThermostatSystemAccess() {
  const token = currentAuthSession?.access_token || "";
  if (!token) return defaultThermostatSystemAccess();
  const response = await fetch("/api/thermostat-system-access", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not load thermostat access settings.");
  }
  return normalizeThermostatSystemAccess(body.settings || {});
}

function renderAutomationSettingsPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  root.innerHTML = `
    <section class="feedback-shell automation-shell">
      <header class="feedback-hero automation-hero">
        <p class="eyebrow">Admin</p>
        <h2>Bot Settings</h2>
        <p>Control automations, alert routing, fallback webhooks, and account access policy from one place.</p>
      </header>

      <form id="automationSettingsForm" class="feedback-form automation-form" autocomplete="off">
        <section class="automation-grid">
          <article id="gymLightsOnCard" class="automation-card">
            <h3>Gym Lights On</h3>
            <p>Triggers opening flow and optional AC fan assist.</p>
            <label class="automation-toggle">
              <input id="gymLightsOnEnabled" type="checkbox" />
              <span>Enable automation</span>
            </label>
            <label class="automation-toggle">
              <input id="gymLightsOnStep1Enabled" type="checkbox" />
              <span>Stage 1 Announcement</span>
            </label>
            <label class="automation-toggle">
              <input id="gymLightsOnStep2Enabled" type="checkbox" />
              <span>Stage 2 Trigger</span>
            </label>
            <label class="automation-toggle">
              <input id="gymLightsOnHalfLightsEnabled" type="checkbox" />
              <span>Use Half Lights Schedule</span>
            </label>
            <label>
              <span>Half Lights Start</span>
              <input id="gymLightsOnHalfLightsStartTime" type="time" />
            </label>
            <label>
              <span>Half Lights End</span>
              <input id="gymLightsOnHalfLightsEndTime" type="time" />
            </label>
            <label class="automation-toggle">
              <input id="gymLightsOnSmsEnabled" type="checkbox" />
              <span>Stage 3 SMS</span>
            </label>
            <label>
              <span>SMS destination</span>
              <input id="gymLightsOnSmsTo" type="text" placeholder="+1..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
            </label>
            <label class="automation-toggle">
              <input id="gymLightsOnAcFanEnabled" type="checkbox" />
              <span>Stage 4 Fan On</span>
            </label>
          </article>

          <article id="gymLightsOffCard" class="automation-card">
            <h3>Gym Lights Off</h3>
            <p>Triggers closing flow and optional AC fan reset.</p>
            <label class="automation-toggle">
              <input id="gymLightsOffEnabled" type="checkbox" />
              <span>Enable automation</span>
            </label>
            <label class="automation-toggle">
              <input id="gymLightsOffStep1Enabled" type="checkbox" />
              <span>Stage 1 Announcement</span>
            </label>
            <label class="automation-toggle">
              <input id="gymLightsOffStep2Enabled" type="checkbox" />
              <span>Stage 2 Trigger</span>
            </label>
            <label class="automation-toggle">
              <input id="gymLightsOffSmsEnabled" type="checkbox" />
              <span>Stage 3 SMS</span>
            </label>
            <label>
              <span>SMS destination</span>
              <input id="gymLightsOffSmsTo" type="text" placeholder="+1..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
            </label>
            <label class="automation-toggle">
              <input id="gymLightsOffAcFanEnabled" type="checkbox" />
              <span>Stage 4 Fan Off</span>
            </label>
          </article>

          <article class="automation-card">
            <h3>Heater Controls</h3>
            <p>Master switch controls for heating automations.</p>
            <label class="automation-toggle">
              <input id="heaterOnEnabled" type="checkbox" />
              <span>Enable heater-on sequence</span>
            </label>
            <label class="automation-toggle">
              <input id="heaterOffEnabled" type="checkbox" />
              <span>Enable heater-off sequence</span>
            </label>
            <label class="automation-toggle">
              <input id="thermostatHeatEnabled" type="checkbox" />
              <span>Allow Heat selection</span>
            </label>
            <label class="automation-toggle">
              <input id="thermostatAcEnabled" type="checkbox" />
              <span>Allow AC selection</span>
            </label>
          </article>
        </section>

        <div class="automation-advanced">
          <button id="toggleAutomationAdvanced" class="auth-secondary" type="button">Show Secret Webhooks</button>
          <p class="automation-note">Sensitive endpoints are masked and stored as secure settings.</p>
          <div id="automationAdvancedFields" class="automation-grid" hidden>
            <article class="automation-card">
              <h3>Gym Lights On Webhooks</h3>
              <label>
                <span>Step 1 URL</span>
                <input id="gymLightsOnStep1Url" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" />
              </label>
              <label>
                <span>Step 2 URL</span>
                <input id="gymLightsOnStep2Url" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" />
              </label>
              <label>
                <span>Half Lights Step 2 URL</span>
                <input id="gymLightsOnHalfLightsStep2Url" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" />
              </label>
            </article>
            <article class="automation-card">
              <h3>Gym Lights Off Webhooks</h3>
              <label>
                <span>Step 1 URL</span>
                <input id="gymLightsOffStep1Url" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" />
              </label>
              <label>
                <span>Step 2 URL</span>
                <input id="gymLightsOffStep2Url" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" />
              </label>
            </article>
          </div>
        </div>

        <div class="feedback-actions">
          <button id="automationSettingsSave" type="submit">Save Settings</button>
          <p id="automationSettingsResult" class="feedback-result" aria-live="polite"></p>
        </div>

        <hr class="settings-divider" />
        <header class="feedback-hero" style="margin-top:0;">
          <p class="eyebrow">Access</p>
          <h2>Account Type Access</h2>
          <p>Edit allowed days/times and temporarily restrict sign-in for each account type.</p>
        </header>

        ${renderAccountTypePolicyFields()}
      </form>
    </section>
  `;

  bindAutomationSettingsActions();
}

function renderAccountTypePolicyFields() {
  const orderedTypes = ["Account Manager", "Kiosk Account", "Special Access Account", "Active Membership", "Weight Room Only", "Open Gym Only", "RESTRICTED ACCOUNT"];
  const dayLabels = ["S", "M", "T", "W", "T", "F", "S"];
  return `
    <section class="account-type-policy-grid">
      ${orderedTypes.map((type) => {
    const key = type.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return `
          <article class="policy-card">
            <h3>${escapeHtml(type)}</h3>
            <label class="automation-toggle">
              <input id="policy_${key}_can_sign_in" type="checkbox" />
              <span>Allow sign-in</span>
            </label>
            <label class="automation-toggle">
              <input id="policy_${key}_bypass" type="checkbox" />
              <span>24/7 bypass time windows</span>
            </label>
            <fieldset class="policy-days" aria-label="Allowed days">
              <legend>Allowed days</legend>
              ${dayLabels.map((label, dayIndex) => `
                <label class="policy-day-chip">
                  <input id="policy_${key}_day_${dayIndex}" type="checkbox" />
                  <span>${label}</span>
                </label>
              `).join("")}
            </fieldset>
            <label>
              <span>Start time</span>
              <input id="policy_${key}_start" type="time" />
            </label>
            <label>
              <span>End time</span>
              <input id="policy_${key}_end" type="time" />
            </label>
          </article>
        `;
  }).join("")}
    </section>
  `;
}

async function renderContractReviewsPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  root.innerHTML = `
    <section class="live-record-page">
      <header class="account-page-heading">
        <div>
          <p class="eyebrow">Admin Approval</p>
          <h2>Account Reviews</h2>
          <p>Approve or reject new membership contracts and invited account users before facility access is enabled.</p>
        </div>
      </header>
      <section class="empty-state">
        <p>Loading account reviews...</p>
      </section>
    </section>
  `;

  try {
    const token = currentAuthSession?.access_token || "";
    if (!token) throw new Error("Log in again before loading reviews.");

    const response = await fetch("/api/signup-reviews", {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) {
      throw new Error(body.error || "Could not load account reviews.");
    }

    renderContractReviewList(body.reviews || []);
  } catch (error) {
    root.innerHTML = `
      <section class="empty-state">
        <p>${escapeHtml(error.message || "Could not load account reviews.")}</p>
      </section>
    `;
  }
}

function renderContractReviewList(reviews) {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  const pending = reviews.filter((review) => review.adminReviewStatus === "pending");
  const reviewed = reviews.filter((review) => review.adminReviewStatus !== "pending").slice(0, 50);
  contractReviewPendingCount = pending.length;
  updateContractReviewBadge();

  root.innerHTML = `
    <section class="live-record-page">
      <header class="account-page-heading">
        <div>
          <p class="eyebrow">Admin Approval</p>
          <h2>Account Reviews</h2>
          <p>Pending accounts stay restricted until approved.</p>
        </div>
        <div class="account-summary-strip">
          <span><strong>${pending.length}</strong> pending</span>
          <span><strong>${reviewed.length}</strong> reviewed</span>
        </div>
      </header>
      <p id="contractReviewResult" class="auth-message" aria-live="polite"></p>
      ${pending.length ? `
        <div class="detail-card">
          <ol class="record-list heater-record-list">
            ${pending.map(renderContractReviewCard).join("")}
          </ol>
        </div>
      ` : `
        <section class="empty-state">
          <p>No pending account reviews.</p>
        </section>
      `}
      ${reviewed.length ? `
        <header class="account-page-heading contract-review-history-heading">
          <div>
            <p class="eyebrow">History</p>
            <h2>Recent Reviews</h2>
          </div>
        </header>
        <div class="detail-card">
          <ol class="record-list heater-record-list">
            ${reviewed.map(renderContractReviewCard).join("")}
          </ol>
        </div>
      ` : ""}
    </section>
  `;

  bindContractReviewActions();
}

function renderContractReviewCard(review) {
  const pending = review.adminReviewStatus === "pending";
  const statusLabel = pending ? "Pending" : review.adminReviewStatus === "approved" ? "Approved" : "Rejected";
  const statusClass = pending ? "currently-on" : review.adminReviewStatus === "approved" ? "paid" : "overdue";
  const meta = [
    review.source,
    review.accountNumber ? `Acct ${review.accountNumber}` : "",
    review.contractSignedAt ? `Signed ${formatShortDateTime(review.contractSignedAt)}` : `Created ${formatShortDateTime(review.createdAt)}`
  ].filter(Boolean).join(" · ");

  return `
    <li data-contract-review-id="${escapeAttribute(review.id)}">
      <strong class="heater-record-event">${escapeHtml(review.applicantName || "Unknown applicant")}</strong>
      <span class="heater-record-meta">${escapeHtml(meta)}</span>
      <button class="heater-state-action is-${escapeAttribute(statusClass)}" type="button" disabled>${escapeHtml(statusLabel)}</button>
      <p class="heater-record-message">
        ${escapeHtml(review.applicantEmail || "No email")} · ${escapeHtml(review.applicantPhone || "No phone")}<br />
        Requested: ${escapeHtml(review.requestedAccountType || "Not set")} · Current: ${escapeHtml(review.currentAccountType || "Not set")}<br />
        Billing: ${escapeHtml(review.billingStatus || "none")} · Plan: ${escapeHtml(review.planLabel || "Not set")} · Children: ${review.householdCount || 0}
        ${review.adminReviewNotes ? `<br />Notes: ${escapeHtml(review.adminReviewNotes)}` : ""}
      </p>
      ${pending ? `
        <div class="form-actions contract-review-actions">
          <button class="text-action" data-contract-review-action="reject" data-contract-review-id="${escapeAttribute(review.id)}" type="button">Reject</button>
          <button class="save-action" data-contract-review-action="approve" data-contract-review-id="${escapeAttribute(review.id)}" type="button">Approve</button>
        </div>
      ` : ""}
    </li>
  `;
}

function bindContractReviewActions() {
  document.querySelectorAll("[data-contract-review-action]").forEach((button) => {
    button.addEventListener("click", () => {
      submitContractReview(button.dataset.contractReviewId, button.dataset.contractReviewAction);
    });
  });
}

async function submitContractReview(contractId, action) {
  const result = document.getElementById("contractReviewResult");
  const notes = action === "reject"
    ? String(window.prompt("Reason for rejection?") || "").trim()
    : String(window.prompt("Approval notes? Optional.") || "").trim();

  if (action === "reject" && !notes) {
    if (result) result.textContent = "Rejection notes are required.";
    return;
  }

  if (result) result.textContent = `${action === "approve" ? "Approving" : "Rejecting"} account review...`;

  try {
    const token = currentAuthSession?.access_token || "";
    if (!token) throw new Error("Log in again before reviewing accounts.");

    const response = await fetch("/api/signup-reviews", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contractId,
        action,
        notes
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) {
      throw new Error(body.error || "Could not update account review.");
    }

    if (result) result.textContent = action === "approve" ? "Account approved." : "Account rejected.";
    await refreshContractReviewBadge();
    window.setTimeout(() => renderContractReviewsPage(), 250);
  } catch (error) {
    if (result) result.textContent = error.message || "Could not update account review.";
  }
}

function renderNotificationsPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  const historyFilter = String(appState.notificationsHistoryFilter || "all");
  const allRecords = [...notificationDispatchRecords]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 100);
  const records = allRecords.filter((record) => {
    if (historyFilter === "all") return true;
    const channels = record.rawChannels || {};
    if (historyFilter === "in_app") return Boolean(channels.inApp || channels.browser);
    if (historyFilter === "text") return Boolean(channels.text);
    if (historyFilter === "email") return Boolean(channels.email);
    return true;
  });

  root.innerHTML = `
    <section class="live-record-page">
      <header class="account-page-heading">
        <div>
          <p class="eyebrow">Sent Messages</p>
          <h2>Message History</h2>
        </div>
      </header>
      <div class="detail-card">
        <div class="notification-history-tabs master-logs-tabs" role="tablist" aria-label="Message history channels">
          <button class="notification-history-tab master-logs-tab ${historyFilter === "all" ? "is-active" : ""}" data-notification-history-filter="all" type="button">All</button>
          <button class="notification-history-tab master-logs-tab ${historyFilter === "in_app" ? "is-active" : ""}" data-notification-history-filter="in_app" type="button">In-App</button>
          <button class="notification-history-tab master-logs-tab ${historyFilter === "text" ? "is-active" : ""}" data-notification-history-filter="text" type="button">Text</button>
          <button class="notification-history-tab master-logs-tab ${historyFilter === "email" ? "is-active" : ""}" data-notification-history-filter="email" type="button">Email</button>
        </div>
      </div>
      ${records.length ? `
      <div class="detail-card">
        <ol class="record-list heater-record-list">
          ${records.map((record) => `
            <li data-notification-item="${escapeAttribute(record.id)}">
              <strong class="heater-record-event">${escapeHtml(record.title)}</strong>
              <span class="heater-record-meta">${escapeHtml(formatNotificationHistoryMeta(record))}</span>
              <button class="heater-state-action is-paid" type="button" disabled>${escapeHtml(record.statusLabel)}</button>
              <p class="heater-record-message">${escapeHtml(record.message || "")}</p>
            </li>
          `).join("")}
        </ol>
      </div>
      ` : `
      <section class="empty-state">
        <p>No messages sent yet.</p>
      </section>
      `}
      <button class="heater-fab message-fab" type="button" aria-label="Create new message">
        <span class="heater-fab-label">New</span>
        <span class="heater-fab-icon" aria-hidden="true">+</span>
      </button>
    </section>
  `;

  document.querySelector(".message-fab")?.addEventListener("click", () => {
    render("messageCompose");
  });
  bindNotificationHistoryFilters();

  bindNotificationOpenActions();
}

async function fetchAdminNotes({ includeArchived = false } = {}) {
  const token = currentAuthSession?.access_token || "";
  if (!token || !isAccountManager(appUserSession)) return [];

  const query = includeArchived ? "?includeArchived=1" : "";
  const response = await fetch(`/api/admin-notes${query}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw createHttpError(body.error || "Could not load admin notes.", response.status);
  }

  return Array.isArray(body.notes) ? body.notes : [];
}

async function createAdminNote(noteText) {
  const token = currentAuthSession?.access_token || "";
  if (!token) {
    throw new Error("Missing session token.");
  }

  const response = await fetch("/api/admin-notes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ noteText })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw createHttpError(body.error || "Could not create admin note.", response.status);
  }

  return body.note || null;
}

async function updateAdminNote(id, patch) {
  const token = currentAuthSession?.access_token || "";
  if (!token) {
    throw new Error("Missing session token.");
  }

  const response = await fetch("/api/admin-notes", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ id, ...patch })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw createHttpError(body.error || "Could not update admin note.", response.status);
  }

  return body.note || null;
}

async function renderAdminNotesPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  root.innerHTML = `
    <section class="live-record-page">
      <header class="account-page-heading">
        <div>
          <p class="eyebrow">Admin Workflow</p>
          <h2>Admin Notes</h2>
          <p>Track messages to send, site edits, and operations follow-ups.</p>
        </div>
      </header>
      <section class="empty-state">
        <p>Loading admin notes...</p>
      </section>
    </section>
  `;

  try {
    adminNotes = await fetchAdminNotes();
    drawAdminNotesPage();
  } catch (error) {
    root.innerHTML = `
      <section class="empty-state">
        <p>${escapeHtml(error.message || "Could not load admin notes.")}</p>
      </section>
    `;
  }
}

function drawAdminNotesPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  const openNotes = adminNotes.filter((note) => !note.archivedAt);
  const completedCount = openNotes.filter((note) => note.isDone).length;

  root.innerHTML = `
    <section class="live-record-page">
      <header class="account-page-heading">
        <div>
          <p class="eyebrow">Admin Workflow</p>
          <h2>Admin Notes</h2>
          <p>Check off work as you finish it. Archive hides finished rows.</p>
        </div>
        <div class="account-summary-strip">
          <span><strong>${openNotes.length}</strong> active</span>
          <span><strong>${completedCount}</strong> complete</span>
        </div>
      </header>

      <div class="detail-card">
        <form id="adminNoteForm" class="feedback-form">
          <label for="adminNoteInput">New note</label>
          <textarea id="adminNoteInput" placeholder="Example: Send Friday member text update."></textarea>
          <div class="feedback-actions">
            <button id="adminNoteSubmit" type="submit">Add Note</button>
            <p id="adminNotesResult" class="feedback-result" aria-live="polite"></p>
          </div>
        </form>
      </div>

      ${openNotes.length ? `
        <div class="detail-card">
          <ol class="record-list heater-record-list">
            ${openNotes.map((note) => `
              <li data-admin-note-id="${escapeAttribute(note.id)}">
                <div class="contract-review-actions">
                  <label class="automation-toggle" style="margin:0;">
                    <input data-admin-note-toggle="${escapeAttribute(note.id)}" type="checkbox" ${note.isDone ? "checked" : ""} />
                    <span><strong>${escapeHtml(note.noteText)}</strong></span>
                  </label>
                  <button class="text-action" data-admin-note-archive="${escapeAttribute(note.id)}" type="button" ${note.isDone ? "" : "disabled"}>Archive</button>
                </div>
                <span class="heater-record-meta">
                  ${note.createdAt ? `Created ${escapeHtml(formatShortDateTime(note.createdAt))}` : ""}
                  ${note.completedAt ? ` · Completed ${escapeHtml(formatShortDateTime(note.completedAt))}` : ""}
                </span>
              </li>
            `).join("")}
          </ol>
        </div>
      ` : `
        <section class="empty-state">
          <p>No admin notes right now.</p>
        </section>
      `}
    </section>
  `;

  bindAdminNotesActions();
}

function bindAdminNotesActions() {
  const form = document.getElementById("adminNoteForm");
  const input = document.getElementById("adminNoteInput");
  const result = document.getElementById("adminNotesResult");
  const submitButton = document.getElementById("adminNoteSubmit");

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = String(input?.value || "").trim();
    if (!text) {
      if (result) result.textContent = "Enter a note first.";
      return;
    }

    try {
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Adding...";
      }
      if (result) result.textContent = "Creating note...";
      await createAdminNote(text);
      adminNotes = await fetchAdminNotes();
      drawAdminNotesPage();
    } catch (error) {
      if (result) result.textContent = error.message || "Could not create note.";
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Add Note";
      }
    }
  });

  document.querySelectorAll("[data-admin-note-toggle]").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      const id = checkbox.getAttribute("data-admin-note-toggle") || "";
      if (!id) return;

      try {
        if (result) result.textContent = "Saving note...";
        await updateAdminNote(id, { isDone: checkbox.checked });
        adminNotes = await fetchAdminNotes();
        drawAdminNotesPage();
      } catch (error) {
        if (result) result.textContent = error.message || "Could not update note.";
      }
    });
  });

  document.querySelectorAll("[data-admin-note-archive]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.getAttribute("data-admin-note-archive") || "";
      if (!id) return;

      try {
        if (result) result.textContent = "Archiving note...";
        await updateAdminNote(id, { archived: true });
        adminNotes = await fetchAdminNotes();
        drawAdminNotesPage();
      } catch (error) {
        if (result) result.textContent = error.message || "Could not archive note.";
      }
    });
  });
}

function renderUserNotificationsPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  const records = [...memberNotifications]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 100);
  const unreadIds = records
    .filter((record) => record.recipientMemberId === appState.authMemberId && !record.readAt)
    .map((record) => record.id);

  root.innerHTML = `
    <section class="live-record-page">
      ${unreadIds.length ? `
      <div class="detail-card">
        <div class="form-actions">
          <button class="save-action" data-notifications-mark-all-read type="button">Mark All Read</button>
        </div>
      </div>
      ` : ""}
      ${records.length ? `
      <div class="detail-card">
        <ol class="record-list heater-record-list">
          ${records.map((record) => `
            <li data-notification-item="${escapeAttribute(record.id)}">
              <strong class="heater-record-event">${escapeHtml(record.title)}</strong>
              <span class="heater-record-meta">${escapeHtml(formatNotificationMeta(record))}</span>
              <button class="heater-state-action is-paid" data-notification-toggle="${escapeAttribute(record.id)}" type="button">${record.readAt ? "Mark Unread" : "Mark Read"}</button>
              <p class="heater-record-message">${escapeHtml(record.message || "")}</p>
            </li>
          `).join("")}
        </ol>
      </div>
      ` : `
      <section class="empty-state">
        <p>No notifications yet.</p>
      </section>
      `}
    </section>
  `;

  bindUserNotificationActions();
  bindMarkAllNotificationsRead();
  bindNotificationOpenActions();
}

function formatNotificationMeta(record) {
  return [
    record.channelsLabel,
    record.recipientsLabel,
    formatShortDateTime(record.createdAt)
  ].filter((value) => String(value || "").trim()).join(" · ");
}

function formatNotificationHistoryMeta(record) {
  return [
    record.channelsLabel,
    record.recipientsLabel,
    formatShortDateTime(record.createdAt)
  ].filter((value) => String(value || "").trim()).join(" · ");
}

function renderMasterLogsPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  const activeTab = appState.masterLogsTab || "timesheet";
  const isThermostatTab = activeTab === "thermostat";
  const isBillingTab = activeTab === "billing";
  const billingFilter = String(appState.masterLogsBillingFilter || "all");
  const timesheetRecords = [...timesheetEntries]
    .sort((a, b) => new Date(b.signedInAt) - new Date(a.signedInAt))
    .slice(0, 500);
  const heaterRecords = [...heaterUseEntries]
    .sort((a, b) => new Date(b.startAt || b.usedOn) - new Date(a.startAt || a.usedOn))
    .slice(0, 500);
  const billingRecords = [...billingLineItems]
    .filter((item) => (
      billingFilter === "all"
        ? true
        : billingFilter === "guest"
          ? Boolean(item.timesheetEntryId)
          : Boolean(item.heaterUseEntryId)
    ))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 500);

  root.innerHTML = `
    <section class="master-logs-shell">
      <header class="account-page-heading">
        <div>
          <p class="eyebrow">Admin Logs</p>
          <h2>Master Logs</h2>
          ${dataSourceNotice()}
        </div>
      </header>

      <div class="master-logs-tabs" role="tablist" aria-label="Master logs views">
        <button class="master-logs-tab ${activeTab === "timesheet" ? "is-active" : ""}" data-master-logs-tab="timesheet" type="button" role="tab" aria-selected="${activeTab === "timesheet"}">
          Timesheet
        </button>
        <button class="master-logs-tab ${activeTab === "thermostat" ? "is-active" : ""}" data-master-logs-tab="thermostat" type="button" role="tab" aria-selected="${activeTab === "thermostat"}">
          Thermostat
        </button>
        <button class="master-logs-tab ${activeTab === "billing" ? "is-active" : ""}" data-master-logs-tab="billing" type="button" role="tab" aria-selected="${activeTab === "billing"}">
          Billing
        </button>
      </div>
      ${isBillingTab ? `
      <div class="detail-card">
        <div class="master-logs-filter-row" role="tablist" aria-label="Billing log filters">
          <button class="master-logs-filter-chip ${billingFilter === "all" ? "is-active" : ""}" data-master-billing-filter="all" type="button">All</button>
          <button class="master-logs-filter-chip ${billingFilter === "guest" ? "is-active" : ""}" data-master-billing-filter="guest" type="button">Guest Sign-In</button>
          <button class="master-logs-filter-chip ${billingFilter === "heater" ? "is-active" : ""}" data-master-billing-filter="heater" type="button">Heater Use</button>
        </div>
      </div>
      ` : ""}

      ${activeTab === "timesheet" ? (timesheetRecords.length ? `
      <div class="detail-card">
          <ol class="record-list master-log-list">
            ${timesheetRecords.map((entry) => {
              const member = entry.memberOrGuest === "Member"
                ? findMember(entry.memberId)
                : findMember(entry.memberEnteredWithId);
              const personLabel = entry.memberOrGuest === "Guest"
                ? `${entry.guestName || "Guest"} (with ${member?.memberName || "Unknown Member"})`
                : (member?.memberName || "Unknown Member");
              return `
                <li data-master-log-type="timesheet" data-master-log-id="${escapeAttribute(entry.id)}">
                  <div>
                    <strong>${escapeHtml(personLabel)}</strong>
                    <span>${escapeHtml(entry.memberOrGuest)} · In ${formatShortDateTime(entry.signedInAt)}${entry.signedOutAt ? ` · Out ${formatShortDateTime(entry.signedOutAt)}` : " · Currently signed in"}</span>
                  </div>
                  <b>${escapeHtml(entry.dayPassOrOpenGym || "Member")}</b>
                </li>
              `;
            }).join("")}
          </ol>
      </div>
      ` : `
      <section class="empty-state">
        <p>No timesheet logs yet.</p>
      </section>
      `) : activeTab === "thermostat" ? (heaterRecords.length ? `
      <div class="detail-card">
          <ol class="record-list master-log-list">
            ${heaterRecords.map((entry) => {
              const member = findMember(entry.responsibleMemberId);
              const stateLabel = heaterRecordStatus(entry).label;
              const payerLabel = entry.groupPay ? "Group Pay" : "Single Pay";
              return `
                <li data-master-log-type="heater" data-master-log-id="${escapeAttribute(entry.id)}">
                  <div>
                    <strong>${escapeHtml(thermostatSystemLabel(entry.systemType))} · ${escapeHtml(member?.memberName || "Unknown Member")}</strong>
                    <span>${formatShortDate(entry.usedOn)} · Start ${formatShortDateTime(entry.startAt)}${entry.endAt ? ` · End ${formatShortDateTime(entry.endAt)}` : " · End pending"} · ${escapeHtml(payerLabel)}</span>
                  </div>
                  <b>${escapeHtml(stateLabel)}</b>
                </li>
              `;
            }).join("")}
          </ol>
      </div>
      ` : `
      <section class="empty-state">
        <p>No thermostat logs yet.</p>
      </section>
      `) : (billingRecords.length ? `
      <div class="detail-card">
          <ol class="record-list master-log-list">
            ${billingRecords.map((item) => {
              const member = findMember(item.accountMemberId);
              return `
                <li data-master-log-type="billing" data-master-log-id="${escapeAttribute(item.id)}">
                  <div>
                    <strong>${escapeHtml(item.reason || "Billing item")} · ${escapeHtml(member?.memberName || "Unknown Member")}</strong>
                    <span>${formatShortDateTime(item.createdAt)}${item.postedToStripeAt ? ` · Posted ${formatShortDateTime(item.postedToStripeAt)}` : ""}</span>
                  </div>
                  <b>${escapeHtml(billingStatusLabel(item))} · ${formatCurrency(item.amountCents || 0)}</b>
                </li>
              `;
            }).join("")}
          </ol>
      </div>
      ` : `
      <section class="empty-state">
        <p>No billing logs for this filter.</p>
      </section>
      `)}
    </section>
  `;

  bindMasterLogsActions();
}

function bindMasterLogsActions() {
  document.querySelectorAll("[data-master-logs-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = String(button.dataset.masterLogsTab || "").trim();
      if (!tab || tab === appState.masterLogsTab) return;
      appState.masterLogsTab = tab;
      renderMasterLogsPage();
    });
  });

  document.querySelectorAll("[data-master-log-id]").forEach((row) => {
    row.addEventListener("click", () => {
      const recordType = String(row.dataset.masterLogType || "").trim();
      const recordId = String(row.dataset.masterLogId || "").trim();
      if (!recordType || !recordId) return;
      openRecordDetail(recordType, recordId);
    });
  });

  document.querySelectorAll("[data-master-billing-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const filter = String(button.dataset.masterBillingFilter || "all");
      if (filter === appState.masterLogsBillingFilter) return;
      appState.masterLogsBillingFilter = filter;
      renderMasterLogsPage();
    });
  });
}

function toDatetimeLocalValue(isoString) {
  if (!isoString) return "";
  const value = new Date(isoString);
  if (Number.isNaN(value.getTime())) return "";
  const local = new Date(value.getTime() - (value.getTimezoneOffset() * 60000));
  return local.toISOString().slice(0, 16);
}

function fromDatetimeLocalValue(localValue) {
  if (!localValue) return null;
  const value = new Date(localValue);
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

function refreshAfterRecordMutation() {
  if (appState.currentRoute === "masterLogs") {
    renderMasterLogsPage();
    return;
  }

  if (appState.currentRoute === "accountDetails") {
    render("accountDetails");
    return;
  }

  render(appState.currentRoute);
}

function openRecordDetail(recordType, recordId) {
  if (recordType === "billing") {
    openBillingLogEditor(recordId);
    return;
  }

  openMasterLogEditor(recordType, recordId);
}

function openMasterLogEditor(recordType, recordId, options = {}) {
  const adminControls = Object.prototype.hasOwnProperty.call(options, "adminControls")
    ? Boolean(options.adminControls)
    : canUseRecordAdminTools();
  const readonlyAttribute = adminControls ? "" : "disabled";
  const isTimesheet = recordType === "timesheet";
  const record = isTimesheet
    ? timesheetEntries.find((entry) => entry.id === recordId)
    : heaterUseEntries.find((entry) => entry.id === recordId);

  if (!record) {
    showDetailActionMessage("Record not found.");
    return;
  }

  const member = findMember(isTimesheet ? (record.memberId || record.memberEnteredWithId) : record.responsibleMemberId);
  const title = isTimesheet ? "Timesheet Log Record" : "Thermostat Log Record";
  const linkedBillingItems = billingLineItems.filter((item) => (
    isTimesheet ? item.timesheetEntryId === recordId : item.heaterUseEntryId === recordId
  ));
  const linkedBillingTotal = linkedBillingItems.reduce((sum, item) => sum + (item.amountCents || 0), 0);

  const overlay = document.createElement("div");
  overlay.className = "master-log-modal-overlay";
  overlay.innerHTML = `
    <section class="master-log-modal" role="dialog" aria-modal="true" aria-label="${escapeAttribute(title)}">
      <h3>${escapeHtml(title)}</h3>
      <p class="master-log-subtitle">${escapeHtml(member?.memberName || "Unknown Member")} · ${escapeHtml(record.id)}</p>
      <div class="master-log-form">
        ${isTimesheet ? `
          <label>
            <span>Type</span>
            <select id="masterLogTimesheetType" ${readonlyAttribute}>
              <option value="Member" ${record.memberOrGuest === "Member" ? "selected" : ""}>Member</option>
              <option value="Guest" ${record.memberOrGuest === "Guest" ? "selected" : ""}>Guest</option>
            </select>
          </label>
          <label>
            <span>Guest Name</span>
            <input id="masterLogGuestName" type="text" value="${escapeAttribute(record.guestName || "")}" ${readonlyAttribute} />
          </label>
          <label>
            <span>Pass Type</span>
            <input id="masterLogPassType" type="text" value="${escapeAttribute(record.dayPassOrOpenGym || "")}" ${readonlyAttribute} />
          </label>
          <label>
            <span>Signed In At</span>
            <input id="masterLogSignedInAt" type="datetime-local" value="${escapeAttribute(toDatetimeLocalValue(record.signedInAt))}" ${readonlyAttribute} />
          </label>
          <label>
            <span>Signed Out At</span>
            <input id="masterLogSignedOutAt" type="datetime-local" value="${escapeAttribute(toDatetimeLocalValue(record.signedOutAt))}" ${readonlyAttribute} />
          </label>
        ` : `
          <label>
            <span>System</span>
            <select id="masterLogThermostatSystem" ${readonlyAttribute}>
              <option value="heat" ${normalizeThermostatSystemType(record.systemType) === "heat" ? "selected" : ""}>Heat</option>
              <option value="ac" ${normalizeThermostatSystemType(record.systemType) === "ac" ? "selected" : ""}>AC</option>
            </select>
          </label>
          <label>
            <span>Heater State</span>
            <select id="masterLogHeaterState" ${readonlyAttribute}>
              <option value="On" ${(record.turnHeaterOn || "On") === "On" ? "selected" : ""}>On</option>
              <option value="Off" ${(record.turnHeaterOn || "On") === "Off" ? "selected" : ""}>Off</option>
            </select>
          </label>
          <label>
            <span>Target Temperature</span>
            <input id="masterLogTargetTemp" type="number" min="45" max="92" value="${escapeAttribute(record.targetTemperatureF || "")}" ${readonlyAttribute} />
          </label>
          <label>
            <span>Start At</span>
            <input id="masterLogHeaterStartAt" type="datetime-local" value="${escapeAttribute(toDatetimeLocalValue(record.startAt))}" ${readonlyAttribute} />
          </label>
          <label>
            <span>End At</span>
            <input id="masterLogHeaterEndAt" type="datetime-local" value="${escapeAttribute(toDatetimeLocalValue(record.endAt))}" ${readonlyAttribute} />
          </label>
          <label>
            <span>Note</span>
            <textarea id="masterLogHeaterNote" rows="4" ${readonlyAttribute}>${escapeHtml(record.note || "")}</textarea>
          </label>
        `}
      </div>
      <p class="master-log-subtitle">Billing items: ${linkedBillingItems.length} · ${formatCurrency(linkedBillingTotal)}</p>
      <p id="masterLogEditorResult" class="member-edit-result"></p>
      <footer>
        ${adminControls ? `
        <button class="master-log-remove-billing" type="button" ${linkedBillingItems.length ? "" : "disabled"}>Remove Billing</button>
        <button class="master-log-delete" type="button">Delete</button>
        ` : ""}
        <button class="master-log-cancel" type="button">${adminControls ? "Cancel" : "Close"}</button>
        ${adminControls ? `
        <button class="master-log-save" type="button">Save</button>
        ` : ""}
      </footer>
    </section>
  `;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKeydown);
  };

  const onKeydown = (event) => {
    if (event.key === "Escape") close();
  };

  const setResult = (message, tone = "default") => {
    const result = overlay.querySelector("#masterLogEditorResult");
    if (!result) return;
    result.textContent = message;
    result.dataset.tone = tone;
  };

  const saveButton = overlay.querySelector(".master-log-save");
  const deleteButton = overlay.querySelector(".master-log-delete");
  const removeBillingButton = overlay.querySelector(".master-log-remove-billing");

  saveButton?.addEventListener("click", async () => {
    const client = await createSupabaseClient();
    if (!client) {
      setResult("App data is not available.", "error");
      return;
    }

    saveButton.disabled = true;
    deleteButton.disabled = true;
    setResult("Saving...");

    try {
      if (isTimesheet) {
        const signedInAt = fromDatetimeLocalValue(String(overlay.querySelector("#masterLogSignedInAt")?.value || ""));
        const signedOutAt = fromDatetimeLocalValue(String(overlay.querySelector("#masterLogSignedOutAt")?.value || ""));
        const payload = {
          member_or_guest: String(overlay.querySelector("#masterLogTimesheetType")?.value || "Member"),
          guest_name: String(overlay.querySelector("#masterLogGuestName")?.value || "").trim() || null,
          day_pass_or_open_gym: String(overlay.querySelector("#masterLogPassType")?.value || "").trim() || null,
          signed_in_at: signedInAt || record.signedInAt,
          signed_out_at: signedOutAt
        };

        const { error } = await client.from("timesheet_entries").update(payload).eq("id", recordId);
        if (error) throw error;
      } else {
        const startAt = fromDatetimeLocalValue(String(overlay.querySelector("#masterLogHeaterStartAt")?.value || ""));
        const endAt = fromDatetimeLocalValue(String(overlay.querySelector("#masterLogHeaterEndAt")?.value || ""));
        const payload = {
          system_type: String(overlay.querySelector("#masterLogThermostatSystem")?.value || record.systemType || "heat"),
          turn_heater_on: String(overlay.querySelector("#masterLogHeaterState")?.value || "On"),
          target_temperature_f: Number(overlay.querySelector("#masterLogTargetTemp")?.value || 0) || null,
          start_at: startAt || record.startAt,
          end_at: endAt,
          note: String(overlay.querySelector("#masterLogHeaterNote")?.value || "").trim() || null
        };

        const { error } = await client.from("heater_use_entries").update(payload).eq("id", recordId);
        if (error) throw error;
      }

      await hydrateFromSupabase();
      refreshAfterRecordMutation();
      close();
    } catch (error) {
      setResult(error.message || "Could not save record.", "error");
      saveButton.disabled = false;
      deleteButton.disabled = false;
    }
  });

  deleteButton?.addEventListener("click", async () => {
    const confirmed = window.confirm("Delete this record?");
    if (!confirmed) return;

    const client = await createSupabaseClient();
    if (!client) {
      setResult("App data is not available.", "error");
      return;
    }

    saveButton.disabled = true;
    deleteButton.disabled = true;
    setResult("Deleting...");

    try {
      if (isTimesheet) {
        const { error } = await client.from("timesheet_entries").delete().eq("id", recordId);
        if (error) throw error;
      } else {
        const { error } = await client.from("heater_use_entries").delete().eq("id", recordId);
        if (error) throw error;
      }

      await hydrateFromSupabase();
      refreshAfterRecordMutation();
      close();
    } catch (error) {
      setResult(error.message || "Could not delete record.", "error");
      saveButton.disabled = false;
      deleteButton.disabled = false;
    }
  });

  removeBillingButton?.addEventListener("click", async () => {
    if (!linkedBillingItems.length) return;

    const confirmed = window.confirm(`Remove ${linkedBillingItems.length} billing item(s) from this log record?`);
    if (!confirmed) return;

    const client = await createSupabaseClient();
    if (!client) {
      setResult("App data is not available.", "error");
      return;
    }

    saveButton.disabled = true;
    deleteButton.disabled = true;
    removeBillingButton.disabled = true;
    setResult("Removing billing...");

    try {
      let query = client.from("billing_line_items").delete();
      query = isTimesheet
        ? query.eq("timesheet_entry_id", recordId)
        : query.eq("heater_use_entry_id", recordId);
      const { error } = await query;
      if (error) throw error;

      await hydrateFromSupabase();
      refreshAfterRecordMutation();
      close();
    } catch (error) {
      setResult(error.message || "Could not remove billing.", "error");
      saveButton.disabled = false;
      deleteButton.disabled = false;
      removeBillingButton.disabled = false;
    }
  });

  overlay.querySelector(".master-log-cancel")?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(overlay);
}

function openBillingLogEditor(recordId, options = {}) {
  const adminControls = Object.prototype.hasOwnProperty.call(options, "adminControls")
    ? Boolean(options.adminControls)
    : canUseRecordAdminTools();
  const readonlyAttribute = adminControls ? "" : "disabled";
  const item = billingLineItems.find((billingItem) => billingItem.id === recordId);

  if (!item) {
    showDetailActionMessage("Billing item not found.");
    return;
  }

  const member = findMember(item.accountMemberId);
  const account = accountForMember(member);
  const timesheetRecord = item.timesheetEntryId
    ? timesheetEntries.find((entry) => entry.id === item.timesheetEntryId)
    : null;
  const heaterRecord = item.heaterUseEntryId
    ? heaterUseEntries.find((entry) => entry.id === item.heaterUseEntryId)
    : null;
  const sourceLabel = timesheetRecord
    ? `Guest sign-in · ${timesheetRecord.guestName || timesheetRecord.memberOrGuest || "Timesheet"}`
    : heaterRecord
      ? `Thermostat use · ${thermostatSystemLabel(heaterRecord.systemType)}`
      : "Manual billing item";
  const amountValue = ((item.amountCents || 0) / 100).toFixed(2);
  const overlay = document.createElement("div");
  overlay.className = "master-log-modal-overlay";
  overlay.innerHTML = `
    <section class="master-log-modal" role="dialog" aria-modal="true" aria-label="Billing log record">
      <h3>Billing Log Record</h3>
      <p class="master-log-subtitle">${escapeHtml(member?.memberName || "Unknown Member")} · ${escapeHtml(account?.accountNumber || "No account")} · ${escapeHtml(item.id)}</p>
      <div class="master-log-form">
        <label>
          <span>Reason</span>
          <input id="billingLogReason" type="text" value="${escapeAttribute(item.reason || "Billing item")}" ${readonlyAttribute} />
        </label>
        <label>
          <span>Amount</span>
          <input id="billingLogAmount" type="number" min="0" step="0.01" value="${escapeAttribute(amountValue)}" ${readonlyAttribute} />
        </label>
        <label>
          <span>Status</span>
          <input type="text" value="${escapeAttribute(billingStatusLabel(item))}" disabled />
        </label>
        <label>
          <span>Created At</span>
          <input type="text" value="${escapeAttribute(formatShortDateTime(item.createdAt))}" disabled />
        </label>
        <label>
          <span>Posted To Stripe At</span>
          <input id="billingLogPostedAt" type="datetime-local" value="${escapeAttribute(toDatetimeLocalValue(item.postedToStripeAt))}" ${readonlyAttribute} />
        </label>
        <label>
          <span>Source</span>
          <input type="text" value="${escapeAttribute(sourceLabel)}" disabled />
        </label>
      </div>
      <p id="billingLogEditorResult" class="member-edit-result"></p>
      <footer>
        ${adminControls ? '<button class="master-log-delete" type="button">Delete</button>' : ""}
        <button class="master-log-cancel" type="button">${adminControls ? "Cancel" : "Close"}</button>
        ${adminControls ? '<button class="master-log-save" type="button">Save</button>' : ""}
      </footer>
    </section>
  `;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKeydown);
  };

  const onKeydown = (event) => {
    if (event.key === "Escape") close();
  };

  const setResult = (message, tone = "default") => {
    const result = overlay.querySelector("#billingLogEditorResult");
    if (!result) return;
    result.textContent = message;
    result.dataset.tone = tone;
  };

  const saveButton = overlay.querySelector(".master-log-save");
  const deleteButton = overlay.querySelector(".master-log-delete");

  saveButton?.addEventListener("click", async () => {
    const reason = String(overlay.querySelector("#billingLogReason")?.value || "").trim();
    const amount = Number(String(overlay.querySelector("#billingLogAmount")?.value || "").replace(/[$,]/g, ""));
    const postedInput = String(overlay.querySelector("#billingLogPostedAt")?.value || "").trim();
    const postedAt = fromDatetimeLocalValue(postedInput);

    if (!reason) {
      setResult("Reason is required.", "error");
      return;
    }

    if (!Number.isFinite(amount) || amount < 0) {
      setResult("Amount must be zero or more.", "error");
      return;
    }

    if (postedInput && !postedAt) {
      setResult("Posted date is invalid.", "error");
      return;
    }

    const client = await createSupabaseClient();
    if (!client) {
      setResult("App data is not available.", "error");
      return;
    }

    saveButton.disabled = true;
    deleteButton.disabled = true;
    setResult("Saving...");

    try {
      const { error } = await client
        .from("billing_line_items")
        .update({
          reason,
          amount_cents: Math.round(amount * 100),
          posted_to_stripe_at: postedAt
        })
        .eq("id", recordId);

      if (error) throw error;

      await hydrateFromSupabase();
      refreshAfterRecordMutation();
      close();
    } catch (error) {
      setResult(error.message || "Could not save billing item.", "error");
      saveButton.disabled = false;
      deleteButton.disabled = false;
    }
  });

  deleteButton?.addEventListener("click", async () => {
    const confirmed = window.confirm("Delete this billing item?");
    if (!confirmed) return;

    const client = await createSupabaseClient();
    if (!client) {
      setResult("App data is not available.", "error");
      return;
    }

    saveButton.disabled = true;
    deleteButton.disabled = true;
    setResult("Deleting...");

    try {
      const { error } = await client.from("billing_line_items").delete().eq("id", recordId);
      if (error) throw error;

      await hydrateFromSupabase();
      refreshAfterRecordMutation();
      close();
    } catch (error) {
      setResult(error.message || "Could not delete billing item.", "error");
      saveButton.disabled = false;
      deleteButton.disabled = false;
    }
  });

  overlay.querySelector(".master-log-cancel")?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(overlay);
}

function bindNotificationOpenActions() {
  document.querySelectorAll("[data-notification-item]").forEach((row) => {
    row.addEventListener("click", () => {
      const notificationId = String(row.dataset.notificationItem || "").trim();
      if (!notificationId) return;
      const notification = notificationDispatchRecords.find((row) => row.id === notificationId)
        || memberNotifications.find((row) => row.id === notificationId);
      if (!notification) return;

      const title = notification.title || "Message";
      const details = [
        formatShortDateTime(notification.createdAt),
        notification.channelsLabel || "",
        notification.recipientsLabel || "",
        notification.statusLabel || "",
        notification.warningsLabel || "",
        "",
        notification.message || "(No message)"
      ].join("\n");

      showAppNotice(details, title);
    });
  });
}

function setNotificationToggleBusy(notificationId, busy) {
  const button = document.querySelector(`[data-notification-toggle="${CSS.escape(notificationId)}"]`);
  if (!button) return;
  if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? "Saving..." : (button.dataset.defaultText || button.textContent);
}

async function markNotificationsReadState(ids = [], read = true) {
  const token = currentAuthSession?.access_token || "";
  if (!token) return;

  const response = await fetch("/api/member-notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ ids, read })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw createHttpError(body.error || "Could not update notifications.", response.status);
  }
}

function bindUserNotificationActions() {
  document.querySelectorAll("[data-notification-toggle]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const notificationId = String(button.dataset.notificationToggle || "").trim();
      if (!notificationId) return;

      const notification = memberNotifications.find((row) => row.id === notificationId);
      if (!notification) return;
      if (notification.recipientMemberId !== appState.authMemberId) return;

      const nextReadState = !notification.readAt;
      setNotificationToggleBusy(notificationId, true);

      try {
        await markNotificationsReadState([notificationId], nextReadState);
        await refreshMemberNotifications({ announceNew: false });
        render("notifications");
      } catch (error) {
        showDetailActionMessage(error.message || "Could not update notification.");
      } finally {
        setNotificationToggleBusy(notificationId, false);
      }
    });
  });
}

function bindMarkAllNotificationsRead() {
  const button = document.querySelector("[data-notifications-mark-all-read]");
  if (!button) return;

  button.addEventListener("click", async () => {
    const unreadIds = memberNotifications
      .filter((record) => record.recipientMemberId === appState.authMemberId && !record.readAt)
      .map((record) => record.id);
    if (!unreadIds.length) return;

    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Saving...";

    try {
      await markNotificationsReadState(unreadIds, true);
      await refreshMemberNotifications({ announceNew: false });
      render("notifications");
    } catch (error) {
      showDetailActionMessage(error.message || "Could not mark all notifications as read.");
      button.disabled = false;
      button.textContent = originalText;
    }
  });
}

function bindNotificationHistoryFilters() {
  document.querySelectorAll("[data-notification-history-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = String(button.dataset.notificationHistoryFilter || "all");
      if (next === appState.notificationsHistoryFilter) return;
      appState.notificationsHistoryFilter = next;
      render("notificationsEmail");
    });
  });
}

function renderMessageComposerPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  const now = new Date();
  const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);

  root.innerHTML = `
    <form id="messageComposerForm" class="form-screen message-composer-screen" autocomplete="off">
      <div class="form-card">
        <label>
          <span>Title<mark>*</mark></span>
          <input id="messageTitle" type="text" required />
        </label>

        <div class="segmented-field">
          <span>Delivery Channels</span>
          <div class="segmented-control" data-multi-select="true">
            <button id="messageChannelText" class="segment" type="button" aria-pressed="false">Text</button>
            <button id="messageChannelEmail" class="segment" type="button" aria-pressed="false">Email</button>
            <button id="messageChannelInApp" class="segment" type="button" aria-pressed="false">In-App</button>
          </div>
        </div>

        <label>
          <span>To Members<mark>*</mark></span>
          <input id="messageMembers" class="member-picker-value" type="hidden" required />
          <button
            id="messageMembersPicker"
            class="member-picker-button multi-member-picker-button"
            data-member-multi-picker="messageMembers"
            data-member-picker-source="memberSignIn"
            data-member-picker-placeholder="Select members"
            data-member-picker-title="To Members"
            type="button"
          >
            <span class="member-picker-selected">
              <span class="member-picker-placeholder">Select members</span>
            </span>
            <span class="member-picker-plus" aria-hidden="true">+</span>
          </button>
        </label>
        <p id="messageRecipientSummary" class="auth-message">No members selected.</p>

        <label>
          <span>Message<mark>*</mark></span>
          <textarea id="messageBody" required></textarea>
        </label>

        <label>
          <span>Time & Date</span>
          <input id="messageSendAt" type="datetime-local" value="${escapeAttribute(localNow)}" />
        </label>

        <p id="messageComposerResult" class="auth-message" aria-live="polite"></p>
      </div>
      <div class="form-actions">
        <button class="text-action" data-route-target="notificationsEmail" type="button">Cancel</button>
        <button id="messageComposerSave" class="save-action" type="submit">Save</button>
      </div>
    </form>
  `;

  bindMessageComposerActions();
}

function selectedMessageMemberIds() {
  const input = document.getElementById("messageMembers");
  return selectedMemberIdsFromInput(input);
}

function setMessageRecipientSummary() {
  const summary = document.getElementById("messageRecipientSummary");
  if (!summary) return;

  const selectedMembers = selectedMessageMemberIds()
    .map((id) => findMember(id))
    .filter(Boolean);

  if (!selectedMembers.length) {
    summary.textContent = "No members selected.";
    return;
  }

  const phones = new Set(
    selectedMembers
      .map((member) => String(member.phoneNumber || "").trim())
      .filter(Boolean)
  );
  const emails = new Set(
    selectedMembers
      .map((member) => String(member.emailAddress || "").trim().toLowerCase())
      .filter(Boolean)
  );

  summary.textContent = `${selectedMembers.length} members selected · ${phones.size} phone numbers · ${emails.size} emails`;
}

async function sendMemberMessage(payload) {
  const token = currentAuthSession?.access_token || "";
  const response = await fetch("/api/send-member-message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not send message.");
  }
  return body;
}

async function triggerHeaterOnSequence(memberIds, options = {}) {
  const token = currentAuthSession?.access_token || "";
  if (!token || !Array.isArray(memberIds)) return;

  const uniqueMemberIds = [...new Set(memberIds)];
  if (uniqueMemberIds.length === 0 && !options.silent) return;

  const response = await fetch("/api/heater-on-sequence", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      memberIds: uniqueMemberIds,
      systemType: options.systemType || "heat",
      targetTemperatureF: options.targetTemperatureF || null,
      silent: Boolean(options.silent)
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Heater-on sequence failed.");
  }
}

async function fetchThermostatStatus({ force = false } = {}) {
  const token = currentAuthSession?.access_token || "";
  const cacheAge = Date.now() - thermostatStatusFetchedAt;

  if (!force && thermostatStatus && cacheAge < THERMOSTAT_STATUS_CACHE_MS) {
    return thermostatStatus;
  }

  if (!token) return thermostatStatus;

  const response = await fetch(`/api/thermostat-status${force ? "?refresh=1" : ""}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not load thermostat status.");
  }

  thermostatStatus = body;
  thermostatStatusFetchedAt = Date.now();
  return thermostatStatus;
}

async function triggerHeaterOffSequence(memberIds = [], options = {}) {
  const token = currentAuthSession?.access_token || "";
  if (!token) return;

  const response = await fetch("/api/heater-off-sequence", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      memberIds: [...new Set((memberIds || []).filter(Boolean))],
      systemType: options.systemType || "heat",
      heaterUseEntryId: options.heaterUseEntryId || null,
      timerTriggered: Boolean(options.timerTriggered),
      timerMinutes: Number(options.timerMinutes || 0) || null
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Heater-off sequence failed.");
  }
}

async function verifyHeaterPin(memberId, pin) {
  const token = currentAuthSession?.access_token || "";
  if (!token) {
    throw new Error("You must be signed in to verify heater PIN.");
  }

  const response = await fetch("/api/verify-heater-pin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ memberId, pin })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Heater PIN verification failed.");
  }
}

function bindMessageComposerActions() {
  const form = document.getElementById("messageComposerForm");
  const saveButton = document.getElementById("messageComposerSave");
  const result = document.getElementById("messageComposerResult");
  const textToggle = document.getElementById("messageChannelText");
  const emailToggle = document.getElementById("messageChannelEmail");
  const inAppToggle = document.getElementById("messageChannelInApp");

  if (!form || !saveButton || !result || !textToggle || !emailToggle || !inAppToggle) return;

  let includeText = false;
  let includeEmail = false;
  let includeInApp = false;

  const renderChannelToggles = () => {
    textToggle.classList.toggle("is-selected", includeText);
    emailToggle.classList.toggle("is-selected", includeEmail);
    inAppToggle.classList.toggle("is-selected", includeInApp);
    textToggle.setAttribute("aria-pressed", String(includeText));
    emailToggle.setAttribute("aria-pressed", String(includeEmail));
    inAppToggle.setAttribute("aria-pressed", String(includeInApp));
  };

  const setResult = (message, tone = "default") => {
    result.textContent = message;
    result.classList.toggle("is-error", tone === "error");
    result.classList.toggle("is-success", tone === "success");
  };

  textToggle.addEventListener("click", () => {
    includeText = !includeText;
    renderChannelToggles();
  });

  emailToggle.addEventListener("click", () => {
    includeEmail = !includeEmail;
    renderChannelToggles();
  });
  inAppToggle.addEventListener("click", () => {
    includeInApp = !includeInApp;
    renderChannelToggles();
  });

  document.getElementById("messageMembers")?.addEventListener("change", setMessageRecipientSummary);
  setMessageRecipientSummary();
  // Force a clean default every time this screen opens.
  includeText = false;
  includeEmail = false;
  includeInApp = false;
  renderChannelToggles();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const title = String(document.getElementById("messageTitle")?.value || "").trim();
    const message = String(document.getElementById("messageBody")?.value || "").trim();
    const memberIds = selectedMessageMemberIds();
    const sendAt = String(document.getElementById("messageSendAt")?.value || "").trim();

    if (!title) {
      setResult("Title is required.", "error");
      return;
    }

    if (!message) {
      setResult("Message is required.", "error");
      return;
    }

    if (!memberIds.length) {
      setResult("Select at least one member.", "error");
      return;
    }

    if (!includeText && !includeEmail && !includeInApp) {
      setResult("Select at least one delivery channel.", "error");
      return;
    }

    saveButton.disabled = true;
    setResult("Sending...");

    try {
      const response = await sendMemberMessage({
        title,
        message,
        memberIds,
        channels: {
          text: includeText,
          email: includeEmail,
          inApp: includeInApp
        },
        sendAt
      });

      setResult(
        `Sent. Texts: ${response.sentTextCount || 0}, Emails: ${response.sentEmailCount || 0}, In-App: ${response.sentInAppCount || 0}.`,
        "success"
      );
      addNotificationDispatchRecord({
        title,
        message,
        includeText,
        includeEmail,
        includeInApp,
        selectedCount: memberIds.length,
        sentTextCount: response.sentTextCount || 0,
        sentEmailCount: response.sentEmailCount || 0,
        sentInAppCount: response.sentInAppCount || 0,
        warnings: response.warnings || [],
        historyRecord: response.historyRecord || null
      });
      const historySaveFailed = (response.warnings || []).some((warning) => (
        String(warning || "").includes("Message history failed")
        || String(warning || "").includes("In-app notifications failed")
      ));
      if (!historySaveFailed) {
        try {
          await refreshMessageHistory();
        } catch (historyError) {
          console.warn("Could not refresh message history.", historyError);
        }
      }
      window.setTimeout(() => render("notificationsEmail"), 220);
    } catch (error) {
      setResult(error.message || "Could not send message.", "error");
    } finally {
      saveButton.disabled = false;
    }
  });
}

function addNotificationDispatchRecord({
  title,
  message,
  includeText,
  includeEmail,
  includeInApp,
  selectedCount,
  sentTextCount,
  sentEmailCount,
  sentInAppCount,
  warnings,
  historyRecord
}) {
  if (historyRecord) {
    const record = normalizeMessageHistoryRecord(historyRecord);
    notificationDispatchRecords = [
      record,
      ...notificationDispatchRecords.filter((item) => item.id !== record.id)
    ];
    return;
  }

  const channels = [];
  if (includeText) channels.push("Text");
  if (includeEmail) channels.push("Email");
  if (includeInApp) channels.push("In-App");
  const rawChannels = {
    text: includeText,
    email: includeEmail,
    inApp: includeInApp
  };
  const warningList = Array.isArray(warnings) ? warnings : [];

  const record = {
    id: `msg-${Date.now()}`,
    title: String(title || "").trim() || "Message",
    message: String(message || ""),
    channelsLabel: channels.join(" + ") || "Unspecified",
    recipientsLabel: `${selectedCount || 0} members`,
    statusLabel: `Text ${sentTextCount || 0} · Email ${sentEmailCount || 0} · In-App ${sentInAppCount || 0}`,
    warningsLabel: warningList.length ? `Warnings: ${warningList.join("; ")}` : "",
    createdAt: new Date().toISOString(),
    rawChannels,
    warnings: warningList
  };
  notificationDispatchRecords.unshift(record);
}

function automationResult(message, tone = "default") {
  const el = document.getElementById("automationSettingsResult");
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone;
}

function applyAutomationSettingsToForm(settings) {
  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value || "";
  };
  const setChecked = (id, checked) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = Boolean(checked);
  };

  setChecked("gymLightsOnEnabled", settings.gym_lights_on?.enabled);
  setChecked("gymLightsOnStep1Enabled", settings.gym_lights_on?.step1_enabled !== false);
  setChecked("gymLightsOnStep2Enabled", settings.gym_lights_on?.step2_enabled !== false);
  setChecked("gymLightsOnHalfLightsEnabled", settings.gym_lights_on?.half_lights_enabled !== false);
  setValue("gymLightsOnHalfLightsStartTime", settings.gym_lights_on?.half_lights_start_time || "07:00");
  setValue("gymLightsOnHalfLightsEndTime", settings.gym_lights_on?.half_lights_end_time || "18:00");
  setChecked("gymLightsOnSmsEnabled", settings.gym_lights_on?.sms_enabled !== false);
  setValue("gymLightsOnStep1Url", settings.gym_lights_on?.step1_url);
  setValue("gymLightsOnStep2Url", settings.gym_lights_on?.step2_url);
  setValue("gymLightsOnHalfLightsStep2Url", settings.gym_lights_on?.half_lights_step2_url);
  setValue("gymLightsOnSmsTo", settings.gym_lights_on?.sms_to);
  setChecked("gymLightsOnAcFanEnabled", settings.gym_lights_on?.ac_fan_enabled !== false);

  setChecked("gymLightsOffEnabled", settings.gym_lights_off?.enabled);
  setChecked("gymLightsOffStep1Enabled", settings.gym_lights_off?.step1_enabled !== false);
  setChecked("gymLightsOffStep2Enabled", settings.gym_lights_off?.step2_enabled !== false);
  setChecked("gymLightsOffSmsEnabled", settings.gym_lights_off?.sms_enabled !== false);
  setValue("gymLightsOffStep1Url", settings.gym_lights_off?.step1_url);
  setValue("gymLightsOffStep2Url", settings.gym_lights_off?.step2_url);
  setValue("gymLightsOffSmsTo", settings.gym_lights_off?.sms_to);
  setChecked("gymLightsOffAcFanEnabled", settings.gym_lights_off?.ac_fan_enabled !== false);

  setChecked("heaterOnEnabled", settings.heater_on?.enabled);
  setChecked("heaterOffEnabled", settings.heater_off?.enabled);
  setChecked("thermostatHeatEnabled", settings.thermostat_system_access?.heat_enabled !== false);
  setChecked("thermostatAcEnabled", settings.thermostat_system_access?.ac_enabled !== false);

  applyAccountTypePoliciesToForm(settings.account_type_permissions || accountTypePolicies || {});
}

function policyFieldKey(accountType) {
  return canonicalAccountType(accountType).toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function formatPolicyTimeForInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.slice(0, 5);
}

function applyAccountTypePoliciesToForm(policies) {
  const defaults = defaultAccountTypePolicies();
  const orderedTypes = ["Account Manager", "Kiosk Account", "Special Access Account", "Active Membership", "Weight Room Only", "Open Gym Only", "RESTRICTED ACCOUNT"];

  orderedTypes.forEach((type) => {
    const policy = policies[type] || defaults[type];
    const key = policyFieldKey(type);
    const canSignIn = document.getElementById(`policy_${key}_can_sign_in`);
    const bypass = document.getElementById(`policy_${key}_bypass`);
    const start = document.getElementById(`policy_${key}_start`);
    const end = document.getElementById(`policy_${key}_end`);
    if (canSignIn) canSignIn.checked = Boolean(policy?.canSignIn);
    if (bypass) bypass.checked = Boolean(policy?.bypassTimeWindows);
    const allowedDays = new Set(policy?.allowedDays || []);
    for (let day = 0; day <= 6; day += 1) {
      const dayInput = document.getElementById(`policy_${key}_day_${day}`);
      if (dayInput) dayInput.checked = allowedDays.has(day);
    }
    if (start) start.value = formatPolicyTimeForInput(policy?.allowedStartTime);
    if (end) end.value = formatPolicyTimeForInput(policy?.allowedEndTime);
  });
}

function collectAutomationSettingsFromForm() {
  const getValue = (id) => String(document.getElementById(id)?.value || "").trim();
  const isChecked = (id) => Boolean(document.getElementById(id)?.checked);

  return {
    gym_lights_on: {
      enabled: isChecked("gymLightsOnEnabled"),
      step1_enabled: isChecked("gymLightsOnStep1Enabled"),
      step2_enabled: isChecked("gymLightsOnStep2Enabled"),
      half_lights_enabled: isChecked("gymLightsOnHalfLightsEnabled"),
      half_lights_start_time: getValue("gymLightsOnHalfLightsStartTime"),
      half_lights_end_time: getValue("gymLightsOnHalfLightsEndTime"),
      sms_enabled: isChecked("gymLightsOnSmsEnabled"),
      step1_url: getValue("gymLightsOnStep1Url"),
      step2_url: getValue("gymLightsOnStep2Url"),
      half_lights_step2_url: getValue("gymLightsOnHalfLightsStep2Url"),
      sms_to: getValue("gymLightsOnSmsTo"),
      ac_fan_enabled: isChecked("gymLightsOnAcFanEnabled")
    },
    gym_lights_off: {
      enabled: isChecked("gymLightsOffEnabled"),
      step1_enabled: isChecked("gymLightsOffStep1Enabled"),
      step2_enabled: isChecked("gymLightsOffStep2Enabled"),
      sms_enabled: isChecked("gymLightsOffSmsEnabled"),
      step1_url: getValue("gymLightsOffStep1Url"),
      step2_url: getValue("gymLightsOffStep2Url"),
      sms_to: getValue("gymLightsOffSmsTo"),
      ac_fan_enabled: isChecked("gymLightsOffAcFanEnabled")
    },
    heater_on: {
      enabled: isChecked("heaterOnEnabled")
    },
    heater_off: {
      enabled: isChecked("heaterOffEnabled")
    },
    thermostat_system_access: {
      heat_enabled: isChecked("thermostatHeatEnabled"),
      ac_enabled: isChecked("thermostatAcEnabled")
    },
    account_type_permissions: collectAccountTypePoliciesFromForm()
  };
}

function collectAccountTypePoliciesFromForm() {
  const orderedTypes = ["Account Manager", "Kiosk Account", "Special Access Account", "Active Membership", "Weight Room Only", "Open Gym Only", "RESTRICTED ACCOUNT"];
  const policies = {};

  orderedTypes.forEach((type) => {
    const key = policyFieldKey(type);
    const canSignIn = Boolean(document.getElementById(`policy_${key}_can_sign_in`)?.checked);
    const bypass = Boolean(document.getElementById(`policy_${key}_bypass`)?.checked);
    const days = [];
    for (let day = 0; day <= 6; day += 1) {
      if (document.getElementById(`policy_${key}_day_${day}`)?.checked) {
        days.push(day);
      }
    }
    const start = String(document.getElementById(`policy_${key}_start`)?.value || "").trim();
    const end = String(document.getElementById(`policy_${key}_end`)?.value || "").trim();
    policies[type] = {
      accountType: type,
      canSignIn,
      bypassTimeWindows: bypass,
      allowedDays: [...new Set(days)],
      allowedStartTime: start ? `${start}:00` : null,
      allowedEndTime: end ? `${end}:00` : null
    };
  });

  return policies;
}

function setAutomationSectionEnabled({ masterId, sectionId, fieldIds }) {
  const master = document.getElementById(masterId);
  const section = document.getElementById(sectionId);
  const enabled = Boolean(master?.checked);
  if (section) {
    section.classList.toggle("automation-card-disabled", !enabled);
  }
  fieldIds.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !enabled;
  });
}

function refreshAutomationSectionStates() {
  setAutomationSectionEnabled({
    masterId: "gymLightsOnEnabled",
    sectionId: "gymLightsOnCard",
    fieldIds: [
      "gymLightsOnStep1Enabled",
      "gymLightsOnStep2Enabled",
      "gymLightsOnHalfLightsEnabled",
      "gymLightsOnHalfLightsStartTime",
      "gymLightsOnHalfLightsEndTime",
      "gymLightsOnSmsEnabled",
      "gymLightsOnSmsTo",
      "gymLightsOnAcFanEnabled"
    ]
  });
  setAutomationSectionEnabled({
    masterId: "gymLightsOffEnabled",
    sectionId: "gymLightsOffCard",
    fieldIds: [
      "gymLightsOffStep1Enabled",
      "gymLightsOffStep2Enabled",
      "gymLightsOffSmsEnabled",
      "gymLightsOffSmsTo",
      "gymLightsOffAcFanEnabled"
    ]
  });
}

async function bindAutomationSettingsActions() {
  const form = document.getElementById("automationSettingsForm");
  const saveButton = document.getElementById("automationSettingsSave");
  if (!form || !saveButton) return;
  const advancedToggle = document.getElementById("toggleAutomationAdvanced");
  const advancedFields = document.getElementById("automationAdvancedFields");

  try {
    automationResult("Loading settings...");
    const settings = await loadAutomationSettings();
    thermostatSystemAccess = normalizeThermostatSystemAccess(settings.thermostat_system_access || {});
    applyAutomationSettingsToForm(settings);
    refreshAutomationSectionStates();
    automationResult("Loaded.", "success");
  } catch (error) {
    automationResult(error.message || "Could not load settings.", "error");
  }
  refreshAutomationSectionStates();

  document.getElementById("gymLightsOnEnabled")?.addEventListener("change", refreshAutomationSectionStates);
  document.getElementById("gymLightsOffEnabled")?.addEventListener("change", refreshAutomationSectionStates);

  advancedToggle?.addEventListener("click", () => {
    if (!advancedFields) return;
    const nextHidden = !advancedFields.hidden;
    advancedFields.hidden = nextHidden;
    advancedToggle.textContent = nextHidden ? "Show Secret Webhooks" : "Hide Secret Webhooks";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
    automationResult("Saving...");

    try {
      const settings = collectAutomationSettingsFromForm();
      await saveAutomationSettings(settings);
      thermostatSystemAccess = normalizeThermostatSystemAccess(settings.thermostat_system_access || {});
      automationResult("Saved.", "success");
    } catch (error) {
      automationResult(error.message || "Could not save settings.", "error");
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = "Save Settings";
    }
  });
}

function bindSharePageActions() {
  document.querySelectorAll("[data-share-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.shareAction;

      if (action === "native") {
        shareRorcApp();
        return;
      }

      if (action === "copy") {
        copyAppLink();
        return;
      }

      if (action === "email") {
        emailAppLink();
        return;
      }

      if (action === "install") {
        requestAppInstall();
      }
    });
  });

  document.getElementById("shareInviteForm")?.addEventListener("submit", inviteAccountUser);
}

function bindAboutPageActions() {
  document.querySelectorAll("[data-about-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.aboutAction;

      if (action === "website") {
        window.open("/", "_blank", "noopener");
        return;
      }

      if (action === "fullAbout") {
        window.open("/about-rorc/", "_blank", "noopener");
        return;
      }

      if (action === "support") {
        window.open("/support/", "_blank", "noopener");
      }
    });
  });
}

function setAuthMessage(message, tone = "default") {
  if (!appAuthMessage) return;

  appAuthMessage.textContent = message;
  appAuthMessage.classList.toggle("is-error", tone === "error");
  appAuthMessage.classList.toggle("is-success", tone === "success");
}

function setAuthButtonBusy(button, busy, busyText) {
  if (!button) return;

  if (!button.dataset.defaultText) {
    button.dataset.defaultText = button.textContent;
  }

  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.defaultText;
}

function showAuthGate(message = "Log in to open the RORC app.", tone = "default") {
  contractReviewPendingCount = 0;
  updateContractReviewBadge();

  if (authGate) {
    authGate.hidden = false;
  }

  if (appShell) {
    appShell.hidden = true;
  }

  closeDrawer();
  setAuthMessage(message, tone);
}

function showAppShell() {
  if (authGate) {
    authGate.hidden = true;
  }

  if (appShell) {
    appShell.hidden = false;
  }
}

function hasSupabaseConfig() {
  return Boolean(
    (supabaseSettings.supabaseUrl || supabaseSettings.url)
    && (supabaseSettings.supabaseAnonKey || supabaseSettings.anonKey)
  );
}

async function createSupabaseClient() {
  if (supabaseClient) {
    return supabaseClient;
  }

  if (window.RORC_SUPABASE?.getClient) {
    supabaseClient = await window.RORC_SUPABASE.getClient();
    return supabaseClient;
  }

  if (!hasSupabaseConfig() || !window.supabase?.createClient) {
    return null;
  }

  supabaseClient = window.supabase.createClient(
    supabaseSettings.supabaseUrl || supabaseSettings.url,
    supabaseSettings.supabaseAnonKey || supabaseSettings.anonKey,
    {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true
      }
    }
  );

  return supabaseClient;
}

function findProfileForSession(session, profiles) {
  if (!session?.user || !Array.isArray(profiles)) {
    return null;
  }

  const metadata = session.user.user_metadata || {};
  const appMetadata = session.user.app_metadata || {};
  const accountMemberId = String(metadata.rorc_account_member_id || appMetadata.rorc_account_member_id || "");
  const email = String(session.user.email || "").trim().toLowerCase();

  return profiles.find((profile) => String(profile.account_member_id || "") === accountMemberId)
    || profiles.find((profile) => String(profile.email_address || "").trim().toLowerCase() === email)
    || (profiles.length === 1 ? profiles[0] : null);
}

function clearLiveData() {
  accounts = [];
  accountMembers = [];
  globalMemberDirectory = [];
  timesheetEntries = [];
  heaterUseEntries = [];
  billingLineItems = [];
  notificationDispatchRecords = [];
  memberNotifications = [];
  notifiedIds = new Set();
  accountTypePolicies = defaultAccountTypePolicies();
  thermostatSystemAccess = defaultThermostatSystemAccess();
  gymLightsMode = "full";
  gymLightsModeFetchedAt = 0;
  gymLightsModeLoading = false;
  supportsMinorMemberFields = false;
}

function initialForSession(session) {
  const profile = findMember(session?.memberId);
  const source = profile?.memberName || appState.currentUserEmail || "?";
  return source.trim().charAt(0).toUpperCase() || "?";
}

function otherUsersOnCurrentAccount() {
  if (!appUserSession.accountId || !appUserSession.memberId) {
    return [];
  }

  return accountMembers
    .filter((member) => member.accountId === appUserSession.accountId && member.id !== appUserSession.memberId)
    .sort(sortMembers);
}

function hasOtherUsersOnCurrentAccount() {
  return otherUsersOnCurrentAccount().length > 0;
}

function updateNavigationVisibility() {
  const showOtherUsers = hasOtherUsersOnCurrentAccount();
  const showAccountManagerPages = isAccountManager(appUserSession);
  const kioskMode = isKioskModeSession(appUserSession);
  const alwaysVisibleRoutes = new Set(["notifications", "about", "share", "calendar", "feedback"]);

  drawerItems
    .filter((item) => item.dataset.route === "otherUsers")
    .forEach((item) => {
      item.hidden = kioskMode || !showOtherUsers;
    });

  drawerItems
    .filter((item) => accountManagerOnlyRoutes.has(item.dataset.route))
    .forEach((item) => {
      item.hidden = kioskMode || !showAccountManagerPages;
    });

  if (kioskMode) {
    drawerItems.forEach((item) => {
      const routeName = item.dataset.route;
      item.hidden = !["feedback", "calendar", "notifications", "about", "share"].includes(routeName);
    });
  }

  drawerItems.forEach((item) => {
    const routeName = item.dataset.route;
    if (alwaysVisibleRoutes.has(routeName)) {
      item.hidden = false;
    }
  });
}

function updateDrawerIdentity() {
  if (drawerAvatar) {
    drawerAvatar.textContent = initialForSession(appUserSession);
  }

  if (drawerUserEmail) {
    drawerUserEmail.textContent = appState.currentUserEmail || appUserSession.memberName || "Signed in";
  }

  updateNavigationVisibility();
  updateNotificationBadge();
  updateContractReviewBadge();
}

function updateNotificationBadge() {
  const badge = document.getElementById("drawerNotificationsBadge");
  if (!badge) return;

  const hasUnread = notificationUnreadCount > 0;
  badge.hidden = !hasUnread;
  badge.textContent = hasUnread ? `New ${notificationUnreadCount}` : "New";
}

function updateContractReviewBadge() {
  const badge = document.getElementById("drawerContractReviewsBadge");
  if (!badge) return;

  const hasPending = isAccountManager(appUserSession) && contractReviewPendingCount > 0;
  badge.hidden = !hasPending;
  badge.textContent = hasPending ? `Review ${contractReviewPendingCount}` : "Review";
}

async function refreshContractReviewBadge() {
  if (!isAccountManager(appUserSession)) {
    contractReviewPendingCount = 0;
    updateContractReviewBadge();
    return;
  }

  const token = currentAuthSession?.access_token || "";
  if (!token) return;

  const response = await fetch("/api/signup-reviews", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not load account review count.");
  }

  contractReviewPendingCount = (body.reviews || [])
    .filter((review) => review.adminReviewStatus === "pending")
    .length;
  updateContractReviewBadge();
}

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = Number(statusCode) || 500;
  return error;
}

function mapTimesheetEntryRow(row) {
  return {
    id: row.id,
    memberId: row.member_id,
    memberOrGuest: row.member_or_guest,
    guestName: row.guest_name || "",
    dayPassOrOpenGym: row.day_pass_or_open_gym || "",
    memberEnteredWithId: row.member_entered_with_id || "",
    liabilityAccepted: Boolean(row.liability_accepted),
    signedInAt: row.signed_in_at,
    signedOutAt: row.signed_out_at || "",
    accountTypeAtSignIn: row.account_type_at_sign_in || "",
    locationLabel: row.location_label || ""
  };
}

function mergeTimesheetRows(...rowGroups) {
  const byId = new Map();
  rowGroups.flat().filter(Boolean).forEach((row) => {
    if (row.id) byId.set(row.id, row);
  });
  return [...byId.values()]
    .sort((a, b) => new Date(b.signed_in_at || 0) - new Date(a.signed_in_at || 0));
}

async function fetchVisibleTimesheetRows(client) {
  const [latestResult, openResult] = await Promise.all([
    client
      .from("timesheet_entries")
      .select("*")
      .order("signed_in_at", { ascending: false })
      .limit(250),
    client
      .from("timesheet_entries")
      .select("*")
      .is("signed_out_at", null)
      .order("signed_in_at", { ascending: false })
      .limit(100)
  ]);

  return {
    data: mergeTimesheetRows(latestResult.data || [], openResult.data || []),
    error: latestResult.error || openResult.error
  };
}

function upsertLocalTimesheetEntries(rows) {
  const nextRows = (Array.isArray(rows) ? rows : [rows])
    .filter(Boolean)
    .map((row) => (
      Object.prototype.hasOwnProperty.call(row, "memberOrGuest")
        ? row
        : mapTimesheetEntryRow(row)
    ))
    .filter((entry) => entry.id);

  if (!nextRows.length) return;

  const byId = new Map(timesheetEntries.map((entry) => [entry.id, entry]));
  nextRows.forEach((entry) => byId.set(entry.id, entry));
  timesheetEntries = [...byId.values()]
    .sort((a, b) => new Date(b.signedInAt || 0) - new Date(a.signedInAt || 0));
  refreshSessions(appState.authMemberId);
}

function markLocalTimesheetSignedOut(entryId, signedOutAt, signOutGuestsForMemberId = "") {
  timesheetEntries = timesheetEntries.map((entry) => {
    const isTargetEntry = entry.id === entryId;
    const isLinkedGuest = Boolean(signOutGuestsForMemberId)
      && entry.memberOrGuest === "Guest"
      && entry.memberEnteredWithId === signOutGuestsForMemberId
      && !entry.signedOutAt;

    return isTargetEntry || isLinkedGuest
      ? { ...entry, signedOutAt }
      : entry;
  });
  refreshSessions(appState.authMemberId);
}

function canUsePrivilegedTimesheetApi() {
  return Boolean(isKioskAccount(appUserSession));
}

async function fetchPrivilegedTimesheetEntries() {
  const token = currentAuthSession?.access_token || "";
  if (!token) return [];

  const response = await fetch("/api/timesheet-entries", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw createHttpError(body.error || "Could not load timesheet entries.", response.status);
  }

  return (body.entries || []).map(mapTimesheetEntryRow);
}

async function insertPrivilegedTimesheetEntries(entries) {
  const token = currentAuthSession?.access_token || "";
  if (!token) {
    throw new Error("Missing session token.");
  }

  const response = await fetch("/api/timesheet-entries", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ entries })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw createHttpError(body.error || "Could not save timesheet entry.", response.status);
  }

  return (body.entries || []).map(mapTimesheetEntryRow);
}

async function signOutPrivilegedTimesheetEntry(entryId, signOutGuestsForMemberId = "", signedOutAt = new Date().toISOString()) {
  const token = currentAuthSession?.access_token || "";
  if (!token) {
    throw new Error("Missing session token.");
  }

  const response = await fetch("/api/timesheet-entries", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      entryId,
      signOutGuestsForMemberId,
      signedOutAt
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw createHttpError(body.error || "Could not sign out.", response.status);
  }
}

async function fetchMemberNotifications() {
  const token = currentAuthSession?.access_token || "";
  if (!token) return [];

  const response = await fetch("/api/member-notifications", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw createHttpError(body.error || "Could not load notifications.", response.status);
  }

  return (body.notifications || []).map((row) => ({
    id: row.id,
    title: row.title || "Notification",
    message: row.message || "",
    channelsLabel: Array.isArray(Object.keys(row.channels || {}))
      ? Object.entries(row.channels || {})
        .filter(([, enabled]) => Boolean(enabled))
        .map(([k]) => (k === "text" ? "Text" : k === "email" ? "Email" : ""))
        .filter(Boolean)
        .join(" + ")
      : "",
    recipientsLabel: row.recipient_member_id === appState.authMemberId ? "" : "Shared account",
    statusLabel: row.recipient_member_id === appState.authMemberId
      ? (row.read_at ? "Read" : "Unread")
      : "Delivered",
    createdAt: row.created_at,
    readAt: row.read_at,
    rawChannels: row.channels || {},
    recipientMemberId: row.recipient_member_id
  }));
}

async function fetchMessageHistory() {
  const token = currentAuthSession?.access_token || "";
  if (!token || !isAccountManager(appUserSession)) return [];

  const response = await fetch("/api/message-history", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw createHttpError(body.error || "Could not load message history.", response.status);
  }

  return (body.history || []).map(normalizeMessageHistoryRecord);
}

async function refreshMessageHistory() {
  notificationDispatchRecords = await fetchMessageHistory();
}

function normalizeMessageHistoryRecord(row) {
  const channels = row.channels || {};
  const activeChannels = [
    channels.inApp ? "In-App" : "",
    channels.text ? "Text" : "",
    channels.email ? "Email" : ""
  ].filter(Boolean);
  const recipientCount = Number(row.recipientCount ?? row.recipient_count ?? 0) || 0;
  const sentTextCount = Number(row.sentTextCount ?? row.sent_text_count ?? 0) || 0;
  const sentEmailCount = Number(row.sentEmailCount ?? row.sent_email_count ?? 0) || 0;
  const sentInAppCount = Number(row.sentInAppCount ?? row.sent_in_app_count ?? 0) || 0;
  const warnings = Array.isArray(row.warnings)
    ? row.warnings
    : Array.isArray(row.errorMessages)
      ? row.errorMessages
      : [];

  return {
    id: row.id || `msg-${Date.now()}`,
    title: row.title || "Message",
    message: row.message || "",
    channelsLabel: activeChannels.join(" + ") || "Unspecified",
    recipientsLabel: `${recipientCount} ${recipientCount === 1 ? "member" : "members"}`,
    statusLabel: `Text ${sentTextCount} · Email ${sentEmailCount} · In-App ${sentInAppCount}`,
    warningsLabel: warnings.length ? `Warnings: ${warnings.join("; ")}` : "",
    createdAt: row.createdAt || row.created_at || new Date().toISOString(),
    rawChannels: {
      text: Boolean(channels.text),
      email: Boolean(channels.email),
      inApp: Boolean(channels.inApp)
    },
    warnings
  };
}

async function refreshMemberNotifications({ announceNew = false } = {}) {
  const rows = await fetchMemberNotifications();
  memberNotifications = rows;
  notificationUnreadCount = rows.filter((row) => row.recipientMemberId === appState.authMemberId && !row.readAt).length;
  updateNotificationBadge();

  if (announceNew) {
    rows.forEach((notification) => {
      if (!notifiedIds.has(notification.id)) {
        notifiedIds.add(notification.id);
      }
    });
  } else {
    rows.forEach((notification) => notifiedIds.add(notification.id));
  }
}

async function markOwnNotificationsRead() {
  const token = currentAuthSession?.access_token || "";
  if (!token) return;

  const ids = memberNotifications
    .filter((row) => row.recipientMemberId === appState.authMemberId && !row.readAt)
    .map((row) => row.id);

  if (!ids.length) return;

  const response = await fetch("/api/member-notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ ids })
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw createHttpError(body.error || "Could not mark notifications as read.", response.status);
  }
}

function stopNotificationRealtime() {
  if (notificationRealtimeRetryTimer) {
    window.clearTimeout(notificationRealtimeRetryTimer);
    notificationRealtimeRetryTimer = null;
  }

  if (notificationRealtimeChannel) {
    try {
      notificationRealtimeChannel.unsubscribe();
    } catch (error) {
      // Ignore unsubscribe failures during cleanup.
    }
    notificationRealtimeChannel = null;
  }
}

function stopTimesheetRealtime() {
  if (timesheetRealtimeRetryTimer) {
    window.clearTimeout(timesheetRealtimeRetryTimer);
    timesheetRealtimeRetryTimer = null;
  }

  if (timesheetRealtimeChannel) {
    try {
      timesheetRealtimeChannel.unsubscribe();
    } catch (error) {
      // Ignore unsubscribe failures during cleanup.
    }
    timesheetRealtimeChannel = null;
  }
}

function stopAccountTypeRealtime() {
  if (accountTypeRealtimeRetryTimer) {
    window.clearTimeout(accountTypeRealtimeRetryTimer);
    accountTypeRealtimeRetryTimer = null;
  }

  if (accountTypeRealtimeChannel) {
    try {
      accountTypeRealtimeChannel.unsubscribe();
    } catch (error) {
      // Ignore unsubscribe failures during cleanup.
    }
    accountTypeRealtimeChannel = null;
  }
}

function scheduleTimesheetRealtimeReconnect() {
  if (!currentAuthSession) return;
  if (timesheetRealtimeRetryTimer) return;
  timesheetRealtimeRetryTimer = window.setTimeout(() => {
    timesheetRealtimeRetryTimer = null;
    void startTimesheetRealtime();
  }, 2500);
}

function scheduleAccountTypeRealtimeReconnect() {
  if (!currentAuthSession) return;
  if (accountTypeRealtimeRetryTimer) return;
  accountTypeRealtimeRetryTimer = window.setTimeout(() => {
    accountTypeRealtimeRetryTimer = null;
    void startAccountTypeRealtime();
  }, 2500);
}

async function startTimesheetRealtime() {
  if (!currentAuthSession) return;
  stopTimesheetRealtime();

  const client = await createSupabaseClient();
  if (!client) return;

  timesheetRealtimeChannel = client
    .channel("timesheet-entries-live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "timesheet_entries" },
      () => {
        syncTimesheetEntries({ rerender: appState.currentRoute === "currentlySignedIn" })
          .catch((error) => {
            console.warn("Could not sync timesheet realtime change.", error);
          });
      }
    )
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await syncTimesheetEntries({ rerender: appState.currentRoute === "currentlySignedIn" })
          .catch((error) => {
            console.warn("Could not sync timesheet after realtime subscribe.", error);
          });
        return;
      }

      if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
        scheduleTimesheetRealtimeReconnect();
      }
    });

}

async function startAccountTypeRealtime() {
  if (!currentAuthSession) return;
  stopAccountTypeRealtime();

  const client = await createSupabaseClient();
  if (!client) return;

  const handleAccountTypeChange = () => {
    syncAccountTypeData({ rerender: true })
      .catch((error) => {
        console.warn("Could not sync account type realtime change.", error);
      });
  };

  accountTypeRealtimeChannel = client
    .channel("account-types-live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "account_members" },
      handleAccountTypeChange
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "account_type_permissions" },
      handleAccountTypeChange
    )
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await syncAccountTypeData({ rerender: false })
          .catch((error) => {
            console.warn("Could not sync account types after realtime subscribe.", error);
          });
        return;
      }

      if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
        scheduleAccountTypeRealtimeReconnect();
      }
    });
}

async function syncTimesheetEntries({ rerender = false } = {}) {
  if (timesheetSyncInFlight) {
    timesheetSyncPending = true;
    timesheetSyncNeedsRender = timesheetSyncNeedsRender || rerender;
    return;
  }

  timesheetSyncInFlight = true;
  try {
    let shouldRerender = rerender;

    do {
      timesheetSyncPending = false;
      shouldRerender = shouldRerender || timesheetSyncNeedsRender;
      timesheetSyncNeedsRender = false;

      if (canUsePrivilegedTimesheetApi()) {
        timesheetEntries = await fetchPrivilegedTimesheetEntries();
      } else {
        const client = await createSupabaseClient();
        if (!client) return;

        const timesheetResult = await fetchVisibleTimesheetRows(client);

        if (timesheetResult.error) {
          throw timesheetResult.error;
        }

        timesheetEntries = (timesheetResult.data || []).map(mapTimesheetEntryRow);
      }

      refreshSessions(appState.authMemberId);
      if (shouldRerender && appState.currentRoute === "currentlySignedIn") {
        renderCurrentlySignedIn();
        bindRouteActions();
      }

      shouldRerender = false;
    } while (timesheetSyncPending);
  } finally {
    timesheetSyncInFlight = false;
  }
}

async function syncAccountTypeData({ rerender = false } = {}) {
  if (!currentAuthSession) return;

  if (accountTypeSyncInFlight) {
    accountTypeSyncPending = true;
    accountTypeSyncNeedsRender = accountTypeSyncNeedsRender || rerender;
    return;
  }

  accountTypeSyncInFlight = true;
  try {
    let shouldRerender = rerender;

    do {
      accountTypeSyncPending = false;
      shouldRerender = shouldRerender || accountTypeSyncNeedsRender;
      accountTypeSyncNeedsRender = false;

      const client = await createSupabaseClient();
      if (!client) return;

      const [profilesResult, permissionsResult] = await Promise.all([
        client
          .from("account_member_profiles")
          .select("*")
          .order("account_number", { ascending: true })
          .order("member_name", { ascending: true }),
        client
          .from("account_type_permissions")
          .select("*")
      ]);

      if (profilesResult.error) {
        throw profilesResult.error;
      }

      if (permissionsResult.error) {
        throw permissionsResult.error;
      }

      const profiles = profilesResult.data || [];
      const currentProfile = findProfileForSession(currentAuthSession, profiles);

      if (!profiles.length || !currentProfile) {
        throw new Error("This signed-in user is not linked to a RORC member profile.");
      }

      applyAccountProfileData(profiles, permissionsResult.data || []);
      appState.authMemberId = currentProfile.account_member_id;
      appState.currentUserEmail = currentAuthSession.user.email || currentProfile.email_address || "";
      refreshSessions(appState.authMemberId);
      updateDrawerIdentity();

      try {
        await loadGlobalMemberDirectory();
      } catch (directoryError) {
        console.warn("Could not refresh full member directory.", directoryError);
      }

      if (shouldRerender) {
        render(appState.currentRoute);
      }

      shouldRerender = false;
    } while (accountTypeSyncPending);
  } finally {
    accountTypeSyncInFlight = false;
  }
}

function scheduleNotificationRealtimeReconnect() {
  if (!currentAuthSession) return;
  if (notificationRealtimeRetryTimer) return;
  notificationRealtimeRetryTimer = window.setTimeout(() => {
    notificationRealtimeRetryTimer = null;
    void startNotificationRealtime();
  }, 2500);
}

async function refreshNotificationsForCurrentRoute(announceNew = true) {
  await refreshMemberNotifications({ announceNew });
  if (appState.currentRoute === "notifications") {
    render("notifications");
  }
  if (appState.currentRoute === "notificationsEmail" && isAccountManager(appUserSession)) {
    await refreshMessageHistory();
    render("notificationsEmail");
  }
}

async function startNotificationRealtime() {
  if (!currentAuthSession) return;
  stopNotificationRealtime();

  const client = await createSupabaseClient();
  if (!client) return;

  notificationRealtimeChannel = client
    .channel("member-notifications-live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "member_notifications" },
      async () => {
        try {
          await refreshNotificationsForCurrentRoute(true);
        } catch (error) {
          if (Number(error?.statusCode) === 401) {
            stopNotificationRealtime();
          }
        }
      }
    )
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        try {
          await refreshNotificationsForCurrentRoute(false);
        } catch (error) {
          if (Number(error?.statusCode) === 401) {
            stopNotificationRealtime();
          }
        }
        return;
      }

      if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
        scheduleNotificationRealtimeReconnect();
      }
    });
}

async function hydrateFromSupabase() {
  const client = await createSupabaseClient();

  if (!client) {
    appState.dataStatus = "error";
    appState.dataError = hasSupabaseConfig()
      ? "App data client script did not load."
      : "App data is not configured for this app.";
    showAuthGate(appState.dataError, "error");
    return false;
  }

  const sessionResult = await client.auth.getSession();

  if (sessionResult.error) {
    throw sessionResult.error;
  }

  currentAuthSession = sessionResult.data.session || null;

  if (!currentAuthSession) {
    showAuthGate("Log in to open the RORC app.");
    return false;
  }

  if (window.RORC_SUPABASE?.getInitialAuthParams?.().type) {
    window.RORC_SUPABASE.cleanAuthUrl?.();
  }

  const initialRoute = requestedInitialRoute();
  if (initialRoute) {
    appState.currentRoute = initialRoute;
  }

  showAppShell();
  appState.dataStatus = "loading";
  render(appState.currentRoute);

  try {
    const profilesResult = await client
      .from("account_member_profiles")
      .select("*")
      .order("account_number", { ascending: true })
      .order("member_name", { ascending: true });

    if (profilesResult.error) {
      throw profilesResult.error;
    }

    let profiles = profilesResult.data || [];
    let currentProfile = findProfileForSession(currentAuthSession, profiles);

    if (!profiles.length) {
      throw new Error("No member profiles were returned for this login.");
    }

    if (!currentProfile) {
      throw new Error("This signed-in user is not linked to a RORC member profile.");
    }

    if (await syncStripeMembershipForProfile(currentProfile)) {
      const refreshedProfilesResult = await client
        .from("account_member_profiles")
        .select("*")
        .order("account_number", { ascending: true })
        .order("member_name", { ascending: true });

      if (refreshedProfilesResult.error) {
        throw refreshedProfilesResult.error;
      }

      profiles = refreshedProfilesResult.data || [];
      currentProfile = findProfileForSession(currentAuthSession, profiles);

      if (!currentProfile) {
        throw new Error("This signed-in user is not linked to a RORC member profile.");
      }
    }

    const [
      timesheetResult,
      heaterResult,
      heaterGroupResult,
      billingResult,
      permissionsResult
    ] = await Promise.all([
      fetchVisibleTimesheetRows(client),
      client
        .from("heater_use_entries_with_duration")
        .select("*")
        .order("used_on", { ascending: false })
        .limit(500),
      client
        .from("heater_use_group_members")
        .select("*"),
      client
        .from("billing_line_items")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1000),
      client
        .from("account_type_permissions")
        .select("*")
    ]);

    const optionalErrors = [
      ["timesheet records", timesheetResult.error],
      ["heater records", heaterResult.error],
      ["heater group records", heaterGroupResult.error],
      ["billing records", billingResult.error],
      ["account type permissions", permissionsResult.error]
    ].filter(([, error]) => Boolean(error));

    applySupabaseData({
      profiles,
      timesheetRows: timesheetResult.error ? [] : (timesheetResult.data || []),
      heaterRows: heaterResult.error ? [] : (heaterResult.data || []),
      heaterGroupRows: heaterGroupResult.error ? [] : (heaterGroupResult.data || []),
      billingRows: billingResult.error ? [] : (billingResult.data || []),
      permissionsRows: permissionsResult.error ? [] : (permissionsResult.data || [])
    });

    appState.authMemberId = currentProfile.account_member_id;
    appState.currentUserEmail = currentAuthSession.user.email || currentProfile.email_address || "";
    appState.dataStatus = optionalErrors.length ? "partial" : "live";
    appState.dataError = optionalErrors.length
      ? `Could not load ${optionalErrors.map(([label]) => label).join(", ")}.`
      : "";
    refreshSessions(appState.authMemberId);
    updateDrawerIdentity();
    try {
      await loadGlobalMemberDirectory();
    } catch (directoryError) {
      console.warn("Could not load full member directory.", directoryError);
    }
    if (isAccountManager(appUserSession)) {
      try {
        await refreshMessageHistory();
      } catch (messageHistoryError) {
        console.warn("Could not load message history.", messageHistoryError);
      }
      try {
        await refreshContractReviewBadge();
      } catch (reviewBadgeError) {
        console.warn("Could not load account review count.", reviewBadgeError);
      }
    }
    if (canUsePrivilegedTimesheetApi()) {
      try {
        timesheetEntries = await fetchPrivilegedTimesheetEntries();
      } catch (timesheetError) {
        console.warn("Could not load privileged timesheet entries.", timesheetError);
        appState.dataStatus = "partial";
        appState.dataError = appState.dataError || "Could not load global timesheet records.";
      }
    }
    try {
      await fetchThermostatStatus();
    } catch (thermostatError) {
      console.warn("Could not load thermostat status.", thermostatError);
    }
    try {
      thermostatSystemAccess = await loadThermostatSystemAccess();
    } catch (thermostatAccessError) {
      thermostatSystemAccess = defaultThermostatSystemAccess();
      console.warn("Could not load thermostat system access settings.", thermostatAccessError);
    }
    try {
      await startNotificationRealtime();
      await startTimesheetRealtime();
      await startAccountTypeRealtime();
    } catch (realtimeError) {
      console.warn("Could not start realtime sync.", realtimeError);
    }
  } catch (error) {
    console.error("Supabase data load failed.", error);
    clearLiveData();
    appState.dataStatus = "error";
    appState.dataError = error.message || "Data load failed.";
    refreshSessions();
    updateDrawerIdentity();
    showAuthGate(appState.dataError, "error");
    return false;
  }

  render(appState.currentRoute);
  return appState.dataStatus === "live";
}

async function loadGlobalMemberDirectory() {
  globalMemberDirectory = [];

  const canLoadFullDirectory = isAccountManager(appUserSession) || isKioskAccount(appUserSession);
  const token = currentAuthSession?.access_token || "";
  if (!canLoadFullDirectory || !token) return;

  const response = await fetch("/api/member-directory", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not load full member directory.");
  }

  const rows = Array.isArray(body.members) ? body.members : [];
  globalMemberDirectory = rows.map((row) => ({
    id: row.account_member_id,
    accountId: row.account_id,
    accountNumber: row.account_number || "",
    memberName: row.member_name || "Unnamed Member",
    accountType: canonicalAccountType(row.account_type),
    legacyAccountType: "",
    phoneNumber: row.phone_number || "",
    emailAddress: row.email_address || "",
    imagePath: "",
    allowGuestEntry: Boolean(row.allow_guest_entry),
    allowHeaterUse: Boolean(row.allow_heater_use),
    isBillingOwner: Boolean(row.is_billing_owner),
    dateOfBirth: row.date_of_birth || "",
    guardianMemberId: row.guardian_member_id || "",
    canAccessIndependently: row.can_access_independently !== false
  }));
}

function applyAccountProfileData(profiles = [], permissionsRows = []) {
  supportsMinorMemberFields = profiles.some((row) => (
    Object.prototype.hasOwnProperty.call(row, "date_of_birth")
    || Object.prototype.hasOwnProperty.call(row, "guardian_member_id")
    || Object.prototype.hasOwnProperty.call(row, "can_access_independently")
  ));

  const accountsById = new Map();

  profiles.forEach((row) => {
    if (!accountsById.has(row.account_id)) {
      accountsById.set(row.account_id, {
        id: row.account_id,
        accountNumber: row.account_number || "",
        membershipDetails: row.membership_details || "",
        notesOnAccount: row.notes_on_account || "",
        expirationDate: row.expiration_date || null,
        billingIdHeater: row.billing_id_heater || "",
        marksAgainstAccount: row.marks_against_account || "",
        heaterPin: row.heater_pin || "",
        billingStatus: row.billing_status || "none",
        stripeCustomerId: row.stripe_customer_id || "",
        stripeStatus: row.stripe_status || "None",
        currentPeriodEnd: row.current_period_end || null,
        lastSync: row.last_sync || null
      });
    }
  });

  accounts = [...accountsById.values()];
  accountMembers = profiles.map((row) => ({
    id: row.account_member_id,
    accountId: row.account_id,
    accountNumber: row.account_number || "",
    memberName: row.member_name || "Unnamed Member",
    accountType: canonicalAccountType(row.account_type),
    legacyAccountType: row.legacy_account_type || "",
    phoneNumber: row.phone_number || "",
    emailAddress: row.email_address || "",
    imagePath: row.image_path || "",
    allowGuestEntry: Boolean(row.allow_guest_entry),
    allowHeaterUse: Boolean(row.allow_heater_use),
    isBillingOwner: Boolean(row.is_billing_owner),
    dateOfBirth: row.date_of_birth || "",
    guardianMemberId: row.guardian_member_id || "",
    canAccessIndependently: row.can_access_independently !== false
  }));

  accountTypePolicies = normalizeAccountTypePolicies(permissionsRows);
}

function applySupabaseData({
  profiles,
  timesheetRows,
  heaterRows,
  heaterGroupRows,
  billingRows,
  permissionsRows
}) {
  applyAccountProfileData(profiles, permissionsRows);

  timesheetEntries = timesheetRows.map(mapTimesheetEntryRow);

  const heaterGroupMap = heaterGroupRows.reduce((map, row) => {
    const current = map.get(row.heater_use_entry_id) || [];
    current.push(row.account_member_id);
    map.set(row.heater_use_entry_id, current);
    return map;
  }, new Map());

  heaterUseEntries = heaterRows.map((row) => ({
    id: row.id,
    usedOn: row.used_on,
    systemType: normalizeThermostatSystemType(row.system_type),
    event: row.event,
    responsibleMemberId: row.responsible_member_id,
    groupMemberIds: heaterGroupMap.get(row.id) || [],
    groupPay: Boolean(row.group_pay),
    turnHeaterOn: row.turn_heater_on || "On",
    targetTemperatureF: Number(row.target_temperature_f || 0) || null,
    setATimer: Boolean(row.set_a_timer),
    timerStart: row.timer_start || null,
    timerStop: row.timer_stop || null,
    startAt: row.start_at,
    endAt: row.end_at,
    paid: Boolean(row.paid),
    note: row.note || ""
  }));

  billingLineItems = billingRows.map((row) => ({
    id: row.id,
    accountMemberId: row.account_member_id,
    timesheetEntryId: row.timesheet_entry_id,
    heaterUseEntryId: row.heater_use_entry_id,
    createdAt: row.created_at,
    amountCents: row.amount_cents || 0,
    reason: row.reason || "Billing item",
    postedToStripeAt: row.posted_to_stripe_at
  }));

}

function normalizeAccountTypePolicies(rows = []) {
  const defaults = defaultAccountTypePolicies();
  const next = { ...defaults };

  rows.forEach((row) => {
    const accountType = canonicalAccountType(row.account_type);
    const allowedDays = Array.isArray(row.allowed_days)
      ? row.allowed_days.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
      : [];

    next[accountType] = {
      accountType,
      canSignIn: Boolean(row.can_sign_in),
      bypassTimeWindows: Boolean(row.bypass_time_windows),
      allowedDays,
      allowedStartTime: row.allowed_start_time || null,
      allowedEndTime: row.allowed_end_time || null
    };
  });

  return next;
}

function resolveMemberId(preferredName, fallbackType) {
  const preferred = accountMembers.find((member) => (
    member.memberName.toLowerCase() === preferredName.toLowerCase()
  ));

  if (preferred) return preferred.id;

  return accountMembers.find((member) => member.accountType === fallbackType)?.id
    || accountMembers[0]?.id
    || "";
}

function refreshSessions(memberId = appState.authMemberId) {
  const sessionMemberId = findMember(memberId)
    ? memberId
    : resolveMemberId("RORC", "Account Manager");

  frontDoorSession = buildSession(sessionMemberId);
  appUserSession = buildSession(sessionMemberId);

  if (!findMember(appState.selectedMemberId)) {
    appState.selectedMemberId = accountMembers[0]?.id || "";
  }
}

function dataSourceNotice() {
  if (appState.dataStatus === "live") {
    return `<p class="data-source-note">Live data</p>`;
  }

  if (appState.dataStatus === "partial") {
    return `<p class="data-source-note is-warning">Live member data. ${escapeHtml(appState.dataError)}</p>`;
  }

  if (appState.dataStatus === "loading") {
    return `<p class="data-source-note">Loading data...</p>`;
  }

  if (appState.dataStatus === "error") {
    return `<p class="data-source-note is-warning">Could not load data. ${escapeHtml(appState.dataError)}</p>`;
  }

  return `<p class="data-source-note is-warning">Waiting for data...</p>`;
}

function openDrawer() {
  if (!appDrawer || !drawerOverlay || !navControl) return;

  appDrawer.classList.add("is-open");
  appDrawer.setAttribute("aria-hidden", "false");
  drawerOverlay.hidden = false;
  navControl.setAttribute("aria-expanded", "true");
  document.body.classList.add("drawer-open");

  if (isAccountManager(appUserSession)) {
    refreshContractReviewBadge().catch((error) => {
      console.warn("Could not refresh account review badge.", error);
    });
  }
}

function closeDrawer() {
  if (!appDrawer || !drawerOverlay || !navControl) return;

  appDrawer.classList.remove("is-open");
  appDrawer.setAttribute("aria-hidden", "true");
  drawerOverlay.hidden = true;
  navControl.setAttribute("aria-expanded", "false");
  document.body.classList.remove("drawer-open");
}

function visibleMembersForSession(session) {
  const kioskOrManager = (
    isAccountManager(session)
    || isKioskAccount(session)
    || isAccountManager(appUserSession)
    || isKioskAccount(appUserSession)
    || isAccountManager(frontDoorSession)
    || isKioskAccount(frontDoorSession)
  );

  if (kioskOrManager) {
    return globalMemberDirectory.length ? globalMemberDirectory : accountMembers;
  }

  return accountMembers.filter((member) => member.accountId === session.accountId);
}

function guestSponsorsForSession(session) {
  return visibleMembersForSession(session)
    .filter((member) => !isKioskAccount(member));
}

function memberPickerOptions(source) {
  const sortOnly = (members) => [...members].sort(sortMembers);
  const kioskOrManager = isAccountManager(appUserSession) || isKioskAccount(appUserSession);

  if ((source === "memberSignIn" || source === "heaterResponsible") && kioskOrManager) {
    return sortOnly(globalMemberDirectory.length ? globalMemberDirectory : accountMembers);
  }

  if (source === "guestSponsors") {
    return sortOnly(guestSponsorsForSession(frontDoorSession));
  }

  if (source === "heaterResponsible") {
    return sortOnly(visibleMembersForSession(frontDoorSession));
  }

  return sortOnly(visibleMembersForSession(frontDoorSession));
}

function memberPickerLabel(member) {
  if (!member) {
    return `<span class="member-picker-placeholder">Select member</span>`;
  }

  return `
    <span class="status-dot ${accountTypeTone(member.accountType)}" aria-hidden="true"></span>
    <span>${escapeHtml(member.memberName)}</span>
  `;
}

function setMemberPickerValue(inputId, memberId) {
  const input = document.getElementById(inputId);
  const button = document.querySelector(`[data-member-picker="${inputId}"]`);
  const label = button?.querySelector(".member-picker-selected");
  const member = findMember(memberId);

  if (!input || !button || !label) return;

  input.value = member?.id || "";
  label.innerHTML = memberPickerLabel(member);
  button.classList.toggle("has-value", Boolean(member));
}

function selectedMemberIdsFromInput(input) {
  return (input?.value || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function setMultiMemberPickerValue(inputId, memberIds) {
  const input = document.getElementById(inputId);
  const button = document.querySelector(`[data-member-multi-picker="${inputId}"]`);
  const label = button?.querySelector(".member-picker-selected");
  const placeholder = button?.dataset.memberPickerPlaceholder || "Select members";
  const selectedMembers = memberIds
    .map((memberId) => findMember(memberId))
    .filter(Boolean);

  if (!input || !button || !label) return;

  input.value = selectedMembers.map((member) => member.id).join(",");
  input.dispatchEvent(new Event("change", { bubbles: true }));
  button.classList.toggle("has-value", selectedMembers.length > 0);

  if (selectedMembers.length === 0) {
    label.innerHTML = `<span class="member-picker-placeholder">${escapeHtml(placeholder)}</span>`;
    return;
  }

  label.innerHTML = `
    <span class="member-picker-chip-row">
      ${selectedMembers.map((member) => `
        <span class="member-picker-chip">
          <span class="status-dot ${accountTypeTone(member.accountType)}" aria-hidden="true"></span>
          <span>${escapeHtml(member.memberName)}</span>
        </span>
      `).join("")}
    </span>
  `;
}

function openMemberPicker(button) {
  const inputId = button.dataset.memberPicker;
  const input = document.getElementById(inputId);
  const source = button.dataset.memberPickerSource;
  const title = button.dataset.memberPickerTitle || "Name";
  const options = memberPickerOptions(source);
  let selectedMemberId = input?.value || "";

  const overlay = document.createElement("div");
  overlay.className = "member-picker-overlay";
  overlay.innerHTML = `
    <section class="member-picker-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <header class="member-picker-header">
        <h2>${escapeHtml(title)}</h2>
      </header>
      <div class="member-picker-search-wrap">
        <label>
          <span>Search</span>
          <input class="member-picker-search" type="search" autocomplete="off" />
        </label>
      </div>
      <div class="member-picker-list" role="radiogroup">
        ${options.map((member) => renderMemberPickerOption(member, selectedMemberId)).join("")}
      </div>
      <footer class="member-picker-footer">
        <button class="member-picker-done" type="button">Done</button>
      </footer>
    </section>
  `;

  document.body.appendChild(overlay);
  document.body.classList.add("picker-open");

  const searchInput = overlay.querySelector(".member-picker-search");
  const doneButton = overlay.querySelector(".member-picker-done");
  const optionButtons = [...overlay.querySelectorAll("[data-member-picker-option]")];

  const close = () => {
    overlay.remove();
    document.body.classList.remove("picker-open");
    document.removeEventListener("keydown", handleKeydown);
  };

  const selectMember = (memberId) => {
    selectedMemberId = memberId;
    optionButtons.forEach((option) => {
      const isSelected = option.dataset.memberPickerOption === memberId;
      option.classList.toggle("is-selected", isSelected);
      option.setAttribute("aria-checked", String(isSelected));
    });
    setMemberPickerValue(inputId, memberId);
  };

  optionButtons.forEach((option) => {
    option.addEventListener("click", () => {
      selectMember(option.dataset.memberPickerOption);
      close();
    });
  });

  searchInput?.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();

    optionButtons.forEach((option) => {
      option.hidden = query !== "" && !option.dataset.search.includes(query);
    });
  });

  doneButton?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  const handleKeydown = (event) => {
    if (event.key === "Escape") {
      close();
    }
  };

  document.addEventListener("keydown", handleKeydown);
}

function openMultiMemberPicker(button) {
  const inputId = button.dataset.memberMultiPicker;
  const input = document.getElementById(inputId);
  const source = button.dataset.memberPickerSource;
  const title = button.dataset.memberPickerTitle || "Names";
  const options = memberPickerOptions(source);
  const selectedMemberIds = new Set(selectedMemberIdsFromInput(input));

  const overlay = document.createElement("div");
  overlay.className = "member-picker-overlay";
  overlay.innerHTML = `
    <section class="member-picker-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <header class="member-picker-header">
        <h2>${escapeHtml(title)}</h2>
      </header>
      <div class="member-picker-search-wrap">
        <label>
          <span>Search</span>
          <input class="member-picker-search" type="search" autocomplete="off" />
        </label>
      </div>
      <div class="member-picker-list" role="group">
        ${options.map((member) => renderMemberPickerOption(member, selectedMemberIds.has(member.id), "checkbox")).join("")}
      </div>
      <footer class="member-picker-footer">
        <button class="member-picker-done" type="button">Done</button>
      </footer>
    </section>
  `;

  document.body.appendChild(overlay);
  document.body.classList.add("picker-open");

  const searchInput = overlay.querySelector(".member-picker-search");
  const doneButton = overlay.querySelector(".member-picker-done");
  const optionButtons = [...overlay.querySelectorAll("[data-member-picker-option]")];

  const close = () => {
    overlay.remove();
    document.body.classList.remove("picker-open");
    document.removeEventListener("keydown", handleKeydown);
  };

  const syncSelection = () => {
    optionButtons.forEach((option) => {
      const isSelected = selectedMemberIds.has(option.dataset.memberPickerOption);
      option.classList.toggle("is-selected", isSelected);
      option.setAttribute("aria-checked", String(isSelected));
    });
    setMultiMemberPickerValue(inputId, [...selectedMemberIds]);
  };

  optionButtons.forEach((option) => {
    option.addEventListener("click", () => {
      const memberId = option.dataset.memberPickerOption;

      if (selectedMemberIds.has(memberId)) {
        selectedMemberIds.delete(memberId);
      } else {
        selectedMemberIds.add(memberId);
      }

      syncSelection();
    });
  });

  searchInput?.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();

    optionButtons.forEach((option) => {
      option.hidden = query !== "" && !option.dataset.search.includes(query);
    });
  });

  doneButton?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  const handleKeydown = (event) => {
    if (event.key === "Escape") {
      close();
    }
  };

  document.addEventListener("keydown", handleKeydown);
}

function renderMemberPickerOption(member, selectedMember, role = "radio") {
  const account = accountForMember(member);
  const memberAccountNumber = displayAccountNumberForMember(member);
  const isSelected = typeof selectedMember === "boolean"
    ? selectedMember
    : member.id === selectedMember;
  const searchValue = [
    member.memberName,
    member.accountType,
    memberAccountNumber,
    member.emailAddress
  ].join(" ").toLowerCase();

  const controlClass = role === "checkbox" ? "member-picker-checkbox" : "member-picker-radio";

  return `
    <button
      class="member-picker-option ${role === "checkbox" ? "is-checkbox" : "is-radio"} ${isSelected ? "is-selected" : ""}"
      data-member-picker-option="${escapeHtml(member.id)}"
      data-search="${escapeHtml(searchValue)}"
      role="${escapeHtml(role)}"
      aria-checked="${isSelected}"
      type="button"
    >
      <span class="${controlClass}" aria-hidden="true"></span>
      <span class="status-dot ${accountTypeTone(member.accountType)}" aria-hidden="true"></span>
      <span class="member-picker-name">${escapeHtml(member.memberName)}</span>
    </button>
  `;
}

function bindMemberPickers() {
  document.querySelectorAll("[data-member-picker]").forEach((button) => {
    const inputId = button.dataset.memberPicker;
    const input = document.getElementById(inputId);

    if (input?.value) {
      setMemberPickerValue(inputId, input.value);
    } else {
      setMemberPickerValue(inputId, "");
    }

    button.addEventListener("click", () => openMemberPicker(button));
  });

  document.querySelectorAll("[data-member-multi-picker]").forEach((button) => {
    const inputId = button.dataset.memberMultiPicker;
    const input = document.getElementById(inputId);

    setMultiMemberPickerValue(inputId, selectedMemberIdsFromInput(input));
    button.addEventListener("click", () => openMultiMemberPicker(button));
  });
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatDateOnly(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric"
  }).format(date);
}

function formatShortDate(value) {
  if (!value) return "Not set";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(parseDateValue(value));
}

function formatShortDateTime(value) {
  if (!value) return "Open";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatShortTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function parseDateValue(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T12:00:00`);
  }

  return new Date(value);
}

function formatCurrency(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(cents / 100);
}

function durationMinutes(start, end) {
  if (!start || !end) return null;

  return Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000));
}

function formatDuration(start, end) {
  const minutes = durationMinutes(start, end);

  if (minutes === null) return "Still signed in";

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours === 0) return `${remainingMinutes}m`;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
}

function isOpenGymWindow(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = values.weekday;
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  const startsAt = (17 * 60) + 50;
  const endsAt = (20 * 60) + 10;

  return ["Tue", "Thu"].includes(weekday) && minutes >= startsAt && minutes <= endsAt;
}

function accountTypeTone(accountType) {
  const normalizedType = canonicalAccountType(accountType);
  if (normalizedType === "Account Manager") return "gray";
  if (normalizedType === "Kiosk Account") return "gray";
  if (normalizedType === "Open Gym Only") return "blue";
  if (normalizedType === "Weight Room Only") return "green";
  if (normalizedType === "RESTRICTED ACCOUNT") return "red";
  if (normalizedType === "Special Access Account") return "purple";
  return "green";
}

function heaterDisplayState(entry) {
  return heaterRecordStatus(entry).label;
}

function normalizeThermostatSystemType(systemType) {
  return String(systemType || "").trim().toLowerCase() === "ac" ? "ac" : "heat";
}

function thermostatTemperatureRange(systemType) {
  return normalizeThermostatSystemType(systemType) === "ac"
    ? { min: 64, max: 92 }
    : { min: 45, max: 92 };
}

function thermostatSystemLabel(systemType) {
  return normalizeThermostatSystemType(systemType) === "ac" ? "AC" : "Heat";
}

function thermostatTempLabel(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? `${Math.round(numeric)}°F` : "Not set";
}

function thermostatSetPointLabel(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? `${Math.round(numeric)}°F` : "-";
}

function thermostatSetPointForSystem(systemType, item, activeEntry = null) {
  const liveValue = systemType === "ac" ? Number(item?.desiredCoolF) : Number(item?.desiredHeatF);
  if (Number.isFinite(liveValue) && liveValue > 0) {
    return liveValue;
  }

  const recordValue = Number(activeEntry?.targetTemperatureF);
  if (Number.isFinite(recordValue) && recordValue > 0) {
    return recordValue;
  }

  return null;
}

function setThermostatActionFeedback(action, systemType, message) {
  thermostatActionFeedback = {
    action,
    systemType: systemType === "ac" ? "ac" : "heat",
    message: message || "",
    startedAt: Date.now()
  };
}

function clearThermostatActionFeedback() {
  thermostatActionFeedback = null;
}

function thermostatPendingActionFor(systemType) {
  if (!thermostatActionFeedback) return null;
  return thermostatActionFeedback.systemType === systemType ? thermostatActionFeedback : null;
}

function thermostatPendingStatusLabel(action) {
  if (action === "off") return "Turning Off...";
  if (action === "temp") return "Updating Temp...";
  if (action === "start") return "Starting...";
  return "";
}

function thermostatPercentLabel(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric)}%` : "Not set";
}

function thermostatModeLabel(value) {
  const raw = String(value || "").trim();
  return raw ? raw.toUpperCase() : "UNKNOWN";
}

function thermostatActivityLabel(item) {
  return String(item?.currentActivity || "").trim()
    || (String(item?.equipmentStatus || "").trim() || "Idle");
}

function thermostatSystemActivityLabel(systemType, item) {
  if (systemType === "ac") {
    if (item?.isCooling) return "AC Cooling";
    if (item?.isFanRunning) return "Fan Running";
  }

  if (systemType === "heat") {
    if (item?.isHeating) return "Heating";
    if (item?.isFanRunning) return "Fan Running";
  }

  return thermostatActivityLabel(item);
}

function thermostatFanLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Auto";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function thermostatAirQualityMetric(item) {
  const air = item?.airQuality || {};
  const status = String(air.status || "").trim().toLowerCase();
  const value = Number(air.value);
  const co2 = Number(air.co2);

  if (["clean", "good", "excellent"].includes(status)) {
    return { label: "Air quality clean", tone: "good" };
  }
  if (["fair", "moderate", "average"].includes(status)) {
    return { label: "Air quality fair", tone: "fair" };
  }
  if (["poor", "bad", "unhealthy"].includes(status)) {
    return { label: "Air quality poor", tone: "bad" };
  }

  if (Number.isFinite(co2) && co2 > 0) {
    if (co2 <= 800) return { label: `CO2 good · ${Math.round(co2)} ppm`, tone: "good" };
    if (co2 <= 1000) return { label: `CO2 fair · ${Math.round(co2)} ppm`, tone: "fair" };
    return { label: `CO2 high · ${Math.round(co2)} ppm`, tone: "bad" };
  }

  if (Number.isFinite(value) && value >= 0) {
    if (value <= 50) return { label: "Air quality clean", tone: "good" };
    if (value <= 100) return { label: "Air quality fair", tone: "fair" };
    return { label: "Air quality poor", tone: "bad" };
  }

  return { label: "Air quality -", tone: "unknown" };
}

function renderThermostatMetric(metric) {
  const resolved = typeof metric === "string" ? { label: metric, tone: "" } : (metric || {});
  const tone = String(resolved.tone || "").trim();
  const className = tone ? ` class="is-${escapeAttribute(tone)}"` : "";
  return `<small${className}>${escapeHtml(resolved.label || "-")}</small>`;
}

function thermostatWeatherLabel(weather, roomHumidity = null) {
  if (!weather) return "Weather unavailable";
  const pieces = [];
  if (Number.isFinite(Number(weather.temperatureF))) {
    pieces.push(`Outside ${Math.round(Number(weather.temperatureF))}°F`);
  }
  const outsideHumidity = Number(weather.humidity);
  const insideHumidity = Number(roomHumidity);
  const humidityLooksDuplicated = Number.isFinite(outsideHumidity)
    && Number.isFinite(insideHumidity)
    && Math.round(outsideHumidity) === Math.round(insideHumidity);

  if (Number.isFinite(outsideHumidity) && !humidityLooksDuplicated) {
    pieces.push(`Outside humidity ${Math.round(outsideHumidity)}%`);
  }
  if (weather.condition) {
    pieces.push(String(weather.condition));
  }
  return pieces.length ? pieces.join(" · ") : "Weather unavailable";
}

function thermostatSensorLabel(item) {
  const sensors = Array.isArray(item?.sensors) ? item.sensors : [];
  if (!sensors.length) return "No sensors";

  const occupied = sensors.filter((sensor) => sensor.occupancy === "occupied").length;
  const inUse = Number(item?.activeSensorCount || 0);
  if (occupied > 0) return `${occupied} occupied`;
  if (inUse > 0) return `${inUse} active sensor${inUse === 1 ? "" : "s"}`;
  return `${sensors.length} sensor${sensors.length === 1 ? "" : "s"}`;
}

function firstConfiguredThermostat(...items) {
  return items.find((item) => item?.configured && !item.error) || null;
}

function renderThermostatSystemStatus(label, item, activeEntry = null) {
  const systemType = label === "AC" ? "ac" : "heat";
  const systemEnabled = isThermostatSystemEnabled(systemType);
  const isActive = normalizeThermostatSystemType(activeEntry?.systemType) === systemType;

  if (isActive) {
    const activity = item?.configured && !item.error
      ? thermostatSystemActivityLabel(systemType, item)
      : "Currently On";
    const pendingAction = thermostatPendingActionFor(systemType);
    const statusLabel = thermostatPendingStatusLabel(pendingAction?.action)
      || (activity && activity !== "Idle" && activity !== "Off" ? activity : "Currently On");
    const setPoint = thermostatSetPointForSystem(systemType, item, activeEntry);
    const timerText = heaterAutoShutoffText(activeEntry);
    const disabledAttr = pendingAction ? " disabled" : "";

    return `
      <article class="is-active" aria-label="${escapeAttribute(label)} thermostat active">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(statusLabel)}</strong>
        <button class="thermostat-setpoint-button" data-change-thermostat-temp type="button"${disabledAttr}>
          <span>Set Temp</span>
          <b>${escapeHtml(thermostatSetPointLabel(setPoint))}</b>
        </button>
        ${timerText ? `<small class="thermostat-timer-chip">${escapeHtml(timerText)}</small>` : ""}
        <button class="thermostat-card-off-button" data-turn-thermostat-off="${escapeAttribute(systemType)}" data-turn-thermostat-entry-id="${escapeAttribute(activeEntry?.id || "")}" type="button"${disabledAttr}>${pendingAction?.action === "off" ? "Turning Off..." : "Turn Off"}</button>
      </article>
    `;
  }

  if (!thermostatStatus) {
    return `
      <article data-open-thermostat-system="${escapeAttribute(systemType)}" class="${systemEnabled ? "" : "is-disabled"}" role="button" tabindex="${systemEnabled ? "0" : "-1"}" aria-disabled="${systemEnabled ? "false" : "true"}">
        <span>${escapeHtml(label)}</span>
        <strong>-</strong>
        <small>${systemEnabled ? "Tap to turn on" : "Disabled by admin"}</small>
      </article>
    `;
  }

  if (!item?.configured) {
    return `
      <article data-open-thermostat-system="${escapeAttribute(systemType)}" class="${systemEnabled ? "" : "is-disabled"}" role="button" tabindex="${systemEnabled ? "0" : "-1"}" aria-disabled="${systemEnabled ? "false" : "true"}">
        <span>${escapeHtml(label)}</span>
        <strong>Not configured</strong>
        <small>${systemEnabled ? "Tap to turn on" : "Disabled by admin"}</small>
      </article>
    `;
  }

  if (item.error) {
    return `
      <article data-open-thermostat-system="${escapeAttribute(systemType)}" class="${systemEnabled ? "" : "is-disabled"}" role="button" tabindex="${systemEnabled ? "0" : "-1"}" aria-disabled="${systemEnabled ? "false" : "true"}">
        <span>${escapeHtml(label)}</span>
        <strong>Status unavailable</strong>
        <small>${systemEnabled ? "Tap to turn on" : "Disabled by admin"}</small>
      </article>
    `;
  }

  const activity = thermostatSystemActivityLabel(systemType, item);

  return `
    <article data-open-thermostat-system="${escapeAttribute(systemType)}" class="${systemEnabled ? "" : "is-disabled"}" role="button" tabindex="${systemEnabled ? "0" : "-1"}" aria-disabled="${systemEnabled ? "false" : "true"}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(activity)}</strong>
      <small>${systemEnabled ? "Tap to turn on" : "Disabled by admin"}</small>
    </article>
  `;
}

function renderThermostatStatusPanel() {
  const status = thermostatStatus?.thermostats || {};
  const activeEntry = activeHeaterEntry();
  const room = firstConfiguredThermostat(status.heat, status.ac) || status.heat || status.ac || {};
  const isLoading = !thermostatStatus;
  const hasRoomData = Boolean(!isLoading && room?.configured && !room.error);
  const roomTitle = hasRoomData ? thermostatTempLabel(room.temperatureF) : "Room status";
  const roomSubtitle = hasRoomData
    ? `Humidity ${thermostatPercentLabel(room.humidity)}`
    : "-";
  const roomMetrics = hasRoomData ? [
    thermostatAirQualityMetric(room),
    thermostatWeatherLabel(room.weather, room.humidity)
  ].filter(Boolean) : ["Air quality -", "-"];

  const refreshed = thermostatStatus?.fetchedAt ? `Updated ${formatShortDateTime(thermostatStatus.fetchedAt)}` : "";
  const systemCards = activeEntry
    ? [normalizeThermostatSystemType(activeEntry.systemType) === "ac"
      ? renderThermostatSystemStatus("AC", status.ac, activeEntry)
      : renderThermostatSystemStatus("Heat", status.heat, activeEntry)]
    : [
      renderThermostatSystemStatus("Heat", status.heat),
      renderThermostatSystemStatus("AC", status.ac)
    ];

  return `
    <div class="thermostat-room-card" aria-label="Live room thermostat data">
      <span>Room</span>
      <strong>${escapeHtml(roomTitle)}</strong>
      <b class="thermostat-activity">${escapeHtml(roomSubtitle)}</b>
      <div class="thermostat-metric-grid">
        ${roomMetrics.map(renderThermostatMetric).join("")}
      </div>
    </div>
    <div class="thermostat-system-grid ${activeEntry ? "is-single" : ""}" aria-label="Heat and AC status">
      ${systemCards.join("")}
    </div>
    ${thermostatActionFeedback?.message ? `<p class="thermostat-action-feedback">${escapeHtml(thermostatActionFeedback.message)}</p>` : ""}
    ${refreshed ? `<p class="data-source-note thermostat-refresh-note">${escapeHtml(refreshed)}</p>` : ""}
  `;
}

function heaterRecordStatus(entry) {
  const isCurrentlyOn = isActiveThermostatEntry(entry);

  return {
    key: isCurrentlyOn ? "currently-on" : "complete",
    label: isCurrentlyOn ? "Currently On" : "Complete"
  };
}

function isOpenThermostatEntry(entry) {
  if (!entry) return false;
  const endAt = String(entry.endAt || "").trim();
  return !endAt;
}

function isActiveThermostatEntry(entry) {
  if (!isOpenThermostatEntry(entry)) return false;
  const state = String(entry?.turnHeaterOn || "On").trim().toLowerCase();
  return state === "on" || !state;
}

function heaterTimerTarget(entry) {
  if (!entry?.setATimer || !entry?.timerStop) return null;
  const startAt = entry.startAt ? new Date(entry.startAt) : null;
  const usedOn = String(entry.usedOn || "").slice(0, 10);
  const stop = String(entry.timerStop || "").slice(0, 5);
  if (!stop) return null;

  const base = startAt && !Number.isNaN(startAt.getTime())
    ? new Date(startAt)
    : (usedOn ? new Date(`${usedOn}T00:00:00`) : null);
  if (!base || Number.isNaN(base.getTime())) return null;

  const [hh, mm] = stop.split(":").map((value) => Number(value));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;

  const target = new Date(base);
  target.setHours(hh, mm, 0, 0);

  if (startAt && target.getTime() < startAt.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target;
}

function heaterCountdownText(entry) {
  if (!entry?.setATimer || entry?.endAt) return "";
  const target = heaterTimerTarget(entry);
  if (!target || Number.isNaN(target.getTime())) return "";
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return "Timer reached";
  const totalMin = Math.max(1, Math.ceil(diffMs / 60000));
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return hours > 0 ? `Timer ${hours}h ${mins}m left` : `Timer ${mins}m left`;
}

function heaterAutoShutoffText(entry) {
  if (!entry?.setATimer || entry?.endAt) return "";
  const target = heaterTimerTarget(entry);
  if (!target || Number.isNaN(target.getTime())) return "";

  const countdown = heaterCountdownText(entry);
  const shutoffTime = formatShortTime(target);
  if (!shutoffTime && !countdown) return "";

  const pieces = [];
  if (shutoffTime) pieces.push(`Auto shutoff ${shutoffTime}`);
  if (countdown) pieces.push(countdown.replace(/^Timer\s+/i, ""));
  return pieces.join(" · ");
}

function configuredTimerMinutes(entry) {
  const target = heaterTimerTarget(entry);
  const start = entry?.startAt ? new Date(entry.startAt) : null;
  if (!target || !start || Number.isNaN(target.getTime()) || Number.isNaN(start.getTime())) return null;
  const minutes = Math.round((target.getTime() - start.getTime()) / 60000);
  return minutes > 0 ? minutes : null;
}

function sortMembers(a, b) {
  const pickerOrder = ["Account Manager", "Kiosk Account", "Special Access Account", "Active Membership", "Weight Room Only", "Open Gym Only", "RESTRICTED ACCOUNT"];
  const resolveTypeIndex = (accountType) => {
    const pickerIndex = pickerOrder.indexOf(accountType);
    if (pickerIndex >= 0) return pickerIndex;
    const statusIndex = statusOrder.indexOf(accountType);
    if (statusIndex >= 0) return statusIndex;
    return 999;
  };

  const typeA = canonicalAccountType(a.accountType);
  const typeB = canonicalAccountType(b.accountType);
  const typeIndexA = resolveTypeIndex(typeA);
  const typeIndexB = resolveTypeIndex(typeB);
  const typeDifference = typeIndexA - typeIndexB;

  if (typeDifference !== 0) return typeDifference;

  const accountA = accountForMember(a)?.accountNumber || "";
  const accountB = accountForMember(b)?.accountNumber || "";
  return accountA.localeCompare(accountB, undefined, { numeric: true }) || a.memberName.localeCompare(b.memberName);
}

function recordsForMember(memberId) {
  const member = findMember(memberId);
  const sameAccountMembers = accountMembers
    .filter((accountMember) => accountMember.accountId === member?.accountId)
    .map((accountMember) => accountMember.id);

  return {
    timesheet: timesheetEntries.filter((entry) => entry.memberId === memberId),
    guests: timesheetEntries.filter((entry) => entry.memberOrGuest === "Guest" && entry.memberEnteredWithId === memberId),
    heater: heaterUseEntries.filter((entry) => entry.responsibleMemberId === memberId || entry.groupMemberIds.includes(memberId)),
    billing: billingLineItems.filter((item) => (
      item.accountMemberId === memberId
      || (member?.isBillingOwner && sameAccountMembers.includes(item.accountMemberId))
    ))
  };
}

function currentMonthRecords(records, dateField) {
  const now = new Date();

  return records.filter((record) => {
    const recordDate = new Date(record[dateField]);
    return recordDate.getMonth() === now.getMonth() && recordDate.getFullYear() === now.getFullYear();
  });
}

function billingStatusLabel(item) {
  return item?.postedToStripeAt ? "Posted" : "Pending Billing";
}

function accessCopy(accountType) {
  const normalizedType = canonicalAccountType(accountType);
  if (normalizedType === "Open Gym Only") return "Open Gym access Tuesday and Thursday nights from 6pm - 8pm.";
  if (normalizedType === "Weight Room Only") return "Weight room access during member hours.";
  if (normalizedType === "Account Manager") return "Account Manager access with full administrative permissions.";
  if (normalizedType === "Kiosk Account") return "Kiosk account access for member sign-in, guest sign-in, currently signed in, heater records, feedback, and calendar.";
  if (normalizedType === "Special Access Account") return "Custom contract access for approved organizations and special-use accounts.";
  if (normalizedType === "RESTRICTED ACCOUNT") return "Access is blocked until the account is approved or restored.";
  return "Basic Membership Access From 7am - 9pm. Follow calendar events for times closed.";
}

function renderCurrentlySignedIn() {
  const root = document.getElementById("currentlySignedInContent");

  if (!root) return;

  const openEntries = timesheetEntries
    .filter((entry) => !entry.signedOutAt)
    .sort((a, b) => new Date(b.signedInAt) - new Date(a.signedInAt));

  if (openEntries.length === 0) {
    root.innerHTML = `
      <section class="empty-state">
        <p>No items</p>
      </section>
    `;
    return;
  }

  root.innerHTML = `
    <section class="live-record-page">
      <div class="account-page-heading">
        <div>
          <p class="eyebrow">Open Timesheet</p>
          <h2>Currently Signed In</h2>
          ${dataSourceNotice()}
        </div>
      </div>
      ${renderGymLightsModeBar(openEntries)}
      <div class="status-panel">
        <div class="member-card-list">
          ${openEntries.map(renderSignedInCard).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderGymLightsModeBar(openEntries) {
  if (!Array.isArray(openEntries) || openEntries.length < 1) return "";
  const halfMode = gymLightsMode === "half";
  return `
    <section class="detail-card gym-lights-mode-card">
      <div class="gym-lights-mode-head">
        <p class="eyebrow">Lights Control</p>
        <p class="gym-lights-mode-status">${halfMode ? "Current mode: Half lights" : "Current mode: Full lights"}</p>
      </div>
      <div class="feedback-actions gym-lights-mode-actions">
        <button data-gym-lights-mode-action="${halfMode ? "full" : "half"}" type="button">
          ${halfMode ? "Turn All Lights On" : "Turn Half The Lights Off"}
        </button>
      </div>
    </section>
  `;
}

function renderCurrentlySignedInRoute() {
  renderCurrentlySignedIn();
  void refreshGymLightsMode({ rerender: true });
  void syncTimesheetEntries({ rerender: true });
}

function renderSignedInCard(entry) {
  const member = entry.memberOrGuest === "Member"
    ? findMember(entry.memberId)
    : findMember(entry.memberEnteredWithId);
  const isGuest = entry.memberOrGuest === "Guest";
  const primaryName = isGuest
    ? entry.guestName || "Guest"
    : member?.memberName || "Unknown Member";
  const guestContext = isGuest
    ? `signed in with ${member?.memberName || "Unknown Member"}`
    : "";

  return `
    <article class="member-list-card as-row signed-in-name-row">
      <span class="status-dot ${accountTypeTone(member?.accountType)}" aria-hidden="true"></span>
      <span class="member-list-main">
        <strong>${escapeHtml(primaryName)}</strong>${isGuest ? `<span class="guest-signin-context">${escapeHtml(guestContext)}</span>` : ""}
      </span>
      <span class="member-list-actions">
        <button class="inline-signout-button" data-sign-out-entry="${escapeAttribute(entry.id)}" type="button">Sign Out</button>
      </span>
    </article>
  `;
}

async function signOutTimesheetEntry(entryId) {
  const button = document.querySelector(`[data-sign-out-entry="${CSS.escape(entryId)}"]`);
  const entry = timesheetEntries.find((item) => item.id === entryId);
  const openCountBefore = openTimesheetCount();
  const signedOutAt = new Date().toISOString();
  const linkedGuestMemberId = entry?.memberOrGuest === "Member" ? entry.memberId : "";
  if (button) {
    button.disabled = true;
    button.textContent = "Signing Out...";
  }

  try {
    if (canUsePrivilegedTimesheetApi()) {
      await signOutPrivilegedTimesheetEntry(
        entryId,
        linkedGuestMemberId,
        signedOutAt
      );
    } else {
      const client = await createSupabaseClient();

      if (!client) {
        throw new Error("App data is not available.");
      }

      const { error } = await client
        .from("timesheet_entries")
        .update({ signed_out_at: signedOutAt })
        .eq("id", entryId)
        .is("signed_out_at", null);

      if (error) {
        throw error;
      }

      if (entry?.memberOrGuest === "Member" && entry.memberId) {
        const guestSignOutResult = await client
          .from("timesheet_entries")
          .update({ signed_out_at: signedOutAt })
          .eq("member_or_guest", "Guest")
          .eq("member_entered_with_id", entry.memberId)
          .is("signed_out_at", null);

        if (guestSignOutResult.error) {
          throw guestSignOutResult.error;
        }
      }
    }

    markLocalTimesheetSignedOut(entryId, signedOutAt, linkedGuestMemberId);
    render("currentlySignedIn");

    if (openCountBefore > 0 && openTimesheetCount() === 0) {
      const member = entry?.memberOrGuest === "Guest"
        ? findMember(entry.memberEnteredWithId)
        : findMember(entry?.memberId);
      const memberName = entry?.memberOrGuest === "Guest"
        ? (entry.guestName || member?.memberName || "Unknown")
        : (member?.memberName || "Unknown");
      const visitDurationMinutes = durationMinutes(entry?.signedInAt, signedOutAt) || 0;
      triggerGymLightsOffSequence(memberName, visitDurationMinutes).catch((sequenceError) => {
        console.warn("Gym lights off sequence failed.", sequenceError);
      });
    }
  } catch (error) {
    showDetailActionMessage(error.message || "Could not sign out.");
    if (button) {
      button.disabled = false;
      button.textContent = "Sign Out";
    }
  }
}

function renderHeaterRecords() {
  const root = document.getElementById("heaterRecordsContent");

  if (!root) {
    bindHeaterRecordsActions();
    return;
  }

  const allRecords = [...heaterUseEntries]
    .sort((a, b) => new Date(b.startAt || b.usedOn) - new Date(a.startAt || a.usedOn))
    .slice(0, 50);
  const canSeeAllRecords = isAccountManager(appUserSession) || isKioskAccount(appUserSession);
  const canSelectRecords = !isKioskAccount(appUserSession);
  const records = canSeeAllRecords
    ? allRecords
    : allRecords.filter((entry) => (
      entry.responsibleMemberId === appUserSession.memberId
      || entry.groupMemberIds.includes(appUserSession.memberId)
    ));
  const recordsNote = isKioskAccount(appUserSession)
    ? "Kiosk view shows all thermostat records. Records are view-only."
    : isAccountManager(appUserSession)
      ? "Admin view shows all thermostat records. Select a record to manage it."
      : "Showing your thermostat records. Select a record to view details.";
  const activeTimerEntry = allRecords.find((entry) => !entry.endAt && entry.setATimer && entry.timerStop);
  const activeTimerCountdown = activeTimerEntry ? heaterCountdownText(activeTimerEntry) : "";
  const activeTimerShutoff = activeTimerEntry ? heaterAutoShutoffText(activeTimerEntry) : "";
  const timerStatusNote = activeTimerEntry
    ? `
      <p class="data-source-note heater-timer-note">
        <span class="heater-timer-note-desktop">${escapeHtml(activeTimerShutoff || "Timer is active")} · Can be turned off early.</span>
        <span class="heater-timer-note-mobile">${escapeHtml(activeTimerCountdown || "Timer is active")} · Can be turned off early.</span>
      </p>
    `
    : "";
  if (!thermostatStatus || (Date.now() - thermostatStatusFetchedAt) > THERMOSTAT_STATUS_CACHE_MS) {
    fetchThermostatStatus({ force: true }).then(() => {
      if (appState.currentRoute === "heaterRecords") {
        render("heaterRecords");
      }
    }).catch((error) => {
      console.warn("Could not refresh thermostat status.", error);
    });
  }

  root.innerHTML = `
    <section class="live-record-page">
      <p class="data-source-note">Live data</p>
      ${renderThermostatStatusPanel()}
      <p class="heater-personal-record-note">${escapeHtml(recordsNote)}</p>
      ${timerStatusNote}
      ${records.length === 0 ? `
        <section class="empty-state">
          <p>No thermostat records yet.</p>
        </section>
      ` : `
      <div class="detail-card thermostat-record-card">
        <ol class="record-list heater-record-list">
          ${records.map((entry) => {
            const member = findMember(entry.responsibleMemberId);
            const heaterState = heaterRecordStatus(entry);
            const timerCountdown = heaterCountdownText(entry);
            const rowAttributes = canSelectRecords
              ? ` data-detail-log-type="heater" data-detail-log-id="${escapeAttribute(entry.id)}" role="button" tabindex="0"`
              : "";
            return `
              <li${rowAttributes}>
                <strong class="heater-record-event">${escapeHtml(thermostatSystemLabel(entry.systemType))}</strong>
                <span class="heater-record-meta">${formatShortDate(entry.usedOn)} · ${escapeHtml(member?.memberName || "No responsible member")} · Set ${thermostatTempLabel(entry.targetTemperatureF)}${timerCountdown ? ` <span class="heater-row-timer">· ${escapeHtml(timerCountdown)}</span>` : ""}</span>
                <button class="heater-state-action is-${escapeHtml(heaterState.key)}" data-heater-state="${escapeHtml(heaterState.key)}" type="button">${escapeHtml(heaterState.label)}</button>
              </li>
            `;
          }).join("")}
        </ol>
      </div>
      `}
    </section>
  `;

  const confirmMessage = document.querySelector("#heaterConfirm .confirm-dialog p");
  const confirmAccept = document.querySelector("[data-heater-confirm-accept]");
  const confirmSystem = document.querySelector("[data-confirm-thermostat-system]");

  if (confirmMessage && confirmAccept) {
    confirmAccept.textContent = "THERMOSTAT ON";
    confirmMessage.innerHTML = "Turn Thermostat On<br /><span>Select heat or AC before starting</span>";
    if (confirmSystem) {
      confirmSystem.hidden = false;
    }
  }

  bindHeaterRecordsActions();

  const expiredTimers = allRecords.filter((entry) => {
    if (!isActiveThermostatEntry(entry) || !entry.setATimer) return false;
    const target = heaterTimerTarget(entry);
    return Boolean(target && target.getTime() <= Date.now());
  });

  expiredTimers.forEach((entry) => {
    turnHeaterOffEntry(entry, { timerTriggered: true });
  });

  if (heaterCountdownTimer) {
    window.clearTimeout(heaterCountdownTimer);
    heaterCountdownTimer = null;
  }

  const hasActiveTimer = allRecords.some((entry) => !entry.endAt && entry.setATimer && entry.timerStop);
  if (hasActiveTimer && appState.currentRoute === "heaterRecords") {
    heaterCountdownTimer = window.setTimeout(() => {
      if (appState.currentRoute === "heaterRecords") {
        render("heaterRecords");
      }
    }, 30000);
  }
}

function activeHeaterEntry(systemType = "") {
  const requestedSystemType = systemType ? normalizeThermostatSystemType(systemType) : "";
  return [...heaterUseEntries]
    .filter((entry) => {
      if (!isActiveThermostatEntry(entry)) return false;
      return requestedSystemType
        ? normalizeThermostatSystemType(entry.systemType) === requestedSystemType
        : true;
    })
    .sort((a, b) => new Date(b.startAt || b.usedOn) - new Date(a.startAt || a.usedOn))[0] || null;
}

function findActiveEntryByIdAndSystem(entryId, systemType = "") {
  const id = String(entryId || "").trim();
  if (!id) return null;
  const requestedSystemType = systemType ? normalizeThermostatSystemType(systemType) : "";
  const entry = heaterUseEntries.find((item) => String(item?.id || "") === id) || null;
  if (!entry || !isActiveThermostatEntry(entry)) return null;
  if (requestedSystemType && normalizeThermostatSystemType(entry.systemType) !== requestedSystemType) return null;
  return entry;
}

async function turnHeaterOffActiveEntry(systemType = "", preferredEntryId = "") {
  const normalizedSystemType = systemType ? normalizeThermostatSystemType(systemType) : "";
  const activeEntry = findActiveEntryByIdAndSystem(preferredEntryId, normalizedSystemType)
    || activeHeaterEntry(normalizedSystemType);

  if (!activeEntry) {
    clearThermostatActionFeedback();
    thermostatStatusFetchedAt = 0;
    await fetchThermostatStatus({ force: true }).catch(() => null);
    await hydrateFromSupabase();
    if (appState.currentRoute === "heaterRecords") render("heaterRecords");
    return;
  }

  const client = await createSupabaseClient();

  if (!client) {
    showDetailActionMessage("App data is not available.");
    return;
  }

  const activeSystemType = normalizeThermostatSystemType(activeEntry.systemType);
  const systemLabel = thermostatSystemLabel(activeSystemType);
  const endAtIso = new Date().toISOString();
  setThermostatActionFeedback("off", activeSystemType, `Turning ${systemLabel} off. This can take a moment.`);
  render("heaterRecords");

  const { data: strictRows, error } = await client
    .from("heater_use_entries")
    .update({
      end_at: endAtIso,
      turn_heater_on: "Off"
    })
    .eq("id", activeEntry.id)
    .is("end_at", null)
    .select("id");

  if (error) {
    throw error;
  }

  if (!Array.isArray(strictRows) || strictRows.length === 0) {
    const { data: fallbackRows, error: fallbackError } = await client
      .from("heater_use_entries")
      .update({
        end_at: endAtIso,
        turn_heater_on: "Off"
      })
      .eq("id", activeEntry.id)
      .select("id");

    if (fallbackError) throw fallbackError;
    if (!Array.isArray(fallbackRows) || fallbackRows.length === 0) {
      clearThermostatActionFeedback();
      thermostatStatusFetchedAt = 0;
      await fetchThermostatStatus({ force: true }).catch(() => null);
      await hydrateFromSupabase();
      if (appState.currentRoute === "heaterRecords") render("heaterRecords");
      return;
    }
  }

  heaterUseEntries = heaterUseEntries.map((entry) => (
    entry.id === activeEntry.id ? { ...entry, endAt: endAtIso, turnHeaterOn: "Off" } : entry
  ));
  render("heaterRecords");

  const offRecipients = activeEntry.groupPay
    ? activeEntry.groupMemberIds
    : [activeEntry.responsibleMemberId];

  await triggerHeaterOffSequence(offRecipients, {
    systemType: activeSystemType,
    heaterUseEntryId: activeEntry.id,
    timerTriggered: false
  }).catch((sequenceError) => {
    console.warn("Heater off sequence failed.", sequenceError);
  });

  thermostatStatusFetchedAt = 0;
  await fetchThermostatStatus({ force: true }).catch((error) => {
    console.warn("Could not refresh thermostat status.", error);
  });
  await hydrateFromSupabase();
  clearThermostatActionFeedback();
  render("heaterRecords");
}

async function turnHeaterOffEntry(entry, { timerTriggered = false } = {}) {
  if (!entry?.id || pendingHeaterAutoOffIds.has(entry.id)) return;
  pendingHeaterAutoOffIds.add(entry.id);

  try {
    const client = await createSupabaseClient();
    if (!client) return;

    const { error } = await client
      .from("heater_use_entries")
      .update({
        end_at: new Date().toISOString(),
        turn_heater_on: "Off"
      })
      .eq("id", entry.id)
      .is("end_at", null);

    if (error) throw error;

    const offRecipients = entry.groupPay ? entry.groupMemberIds : [entry.responsibleMemberId];
    await triggerHeaterOffSequence(offRecipients, {
      systemType: normalizeThermostatSystemType(entry.systemType),
      heaterUseEntryId: entry.id,
      timerTriggered,
      timerMinutes: timerTriggered ? configuredTimerMinutes(entry) : null
    }).catch((sequenceError) => {
      console.warn("Heater off sequence failed.", sequenceError);
    });

    thermostatStatusFetchedAt = 0;
    await fetchThermostatStatus({ force: true }).catch((error) => {
      console.warn("Could not refresh thermostat status.", error);
    });
    await hydrateFromSupabase();
    if (appState.currentRoute === "heaterRecords") {
      render("heaterRecords");
    }
  } catch (error) {
    console.warn("Auto heater off failed.", error);
  } finally {
    pendingHeaterAutoOffIds.delete(entry.id);
  }
}

async function changeActiveThermostatTemperature() {
  const activeEntry = activeHeaterEntry();

  if (!activeEntry) {
    showDetailActionMessage("No active thermostat record found.");
    return;
  }

  const nextTemp = await openThermostatTemperatureDialog(activeEntry);
  if (nextTemp === null) return;
  const systemType = normalizeThermostatSystemType(activeEntry.systemType);
  const allowedRange = thermostatTemperatureRange(systemType);

  if (!Number.isFinite(nextTemp) || nextTemp < allowedRange.min || nextTemp > allowedRange.max) {
    showDetailActionMessage(`Enter a temperature between ${allowedRange.min} and ${allowedRange.max}.`);
    return;
  }

  const client = await createSupabaseClient();
  if (!client) {
    showDetailActionMessage("App data is not available.");
    return;
  }

  setThermostatActionFeedback("temp", systemType, `Updating ${thermostatSystemLabel(systemType)} to ${Math.round(nextTemp)}°F.`);
  render("heaterRecords");

  const { error } = await client
    .from("heater_use_entries")
    .update({ target_temperature_f: Math.round(nextTemp) })
    .eq("id", activeEntry.id)
    .is("end_at", null);

  if (error) {
    throw error;
  }

  heaterUseEntries = heaterUseEntries.map((entry) => (
    entry.id === activeEntry.id ? { ...entry, targetTemperatureF: Math.round(nextTemp) } : entry
  ));
  render("heaterRecords");

  await triggerHeaterOnSequence([], {
    systemType,
    targetTemperatureF: Math.round(nextTemp),
    silent: true
  });

  thermostatStatusFetchedAt = 0;
  await fetchThermostatStatus({ force: true }).catch((error) => {
    console.warn("Could not refresh thermostat status.", error);
  });
  await hydrateFromSupabase();
  clearThermostatActionFeedback();
  render("heaterRecords");
}

function openThermostatTemperatureDialog(activeEntry) {
  return new Promise((resolve) => {
    const systemLabel = thermostatSystemLabel(activeEntry.systemType);
    const activeSystem = normalizeThermostatSystemType(activeEntry.systemType);
    const allowedRange = thermostatTemperatureRange(activeSystem);
    const statusItem = thermostatStatus?.thermostats?.[activeSystem === "ac" ? "ac" : "heat"] || null;
    const currentTemp = thermostatSetPointForSystem(activeEntry.systemType, statusItem, activeEntry)
      || (activeSystem === "ac" ? 66 : 74);
    const overlay = document.createElement("div");
    overlay.className = "thermostat-temp-modal-overlay";
    overlay.innerHTML = `
      <section class="thermostat-temp-modal" role="dialog" aria-modal="true" aria-label="Set ${escapeAttribute(systemLabel)} temperature">
        <h3>Set ${escapeHtml(systemLabel)} Temperature</h3>
        <label>
          <span>Set Temp</span>
          <input id="thermostatTempModalInput" type="number" min="${allowedRange.min}" max="${allowedRange.max}" inputmode="numeric" value="${escapeAttribute(currentTemp)}" />
        </label>
        <p id="thermostatTempModalError" class="thermostat-temp-modal-error"></p>
        <footer>
          <button class="thermostat-temp-cancel" type="button">Cancel</button>
          <button class="thermostat-temp-save" type="button">Confirm</button>
        </footer>
      </section>
    `;

    const close = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(value);
    };

    const setError = (message) => {
      const error = overlay.querySelector("#thermostatTempModalError");
      if (error) error.textContent = message;
    };

    const save = () => {
      const input = overlay.querySelector("#thermostatTempModalInput");
      const value = Number(String(input?.value || "").replace(/[^\d.]/g, ""));
      if (!Number.isFinite(value) || value < allowedRange.min || value > allowedRange.max) {
        setError(`Enter a temperature between ${allowedRange.min} and ${allowedRange.max}.`);
        return;
      }
      close(Math.round(value));
    };

    const onKeydown = (event) => {
      if (event.key === "Escape") {
        close(null);
      }
      if (event.key === "Enter") {
        event.preventDefault();
        save();
      }
    };

    overlay.querySelector(".thermostat-temp-cancel")?.addEventListener("click", () => close(null));
    overlay.querySelector(".thermostat-temp-save")?.addEventListener("click", save);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(null);
    });

    document.addEventListener("keydown", onKeydown);
    document.body.appendChild(overlay);
    overlay.querySelector("#thermostatTempModalInput")?.focus();
    overlay.querySelector("#thermostatTempModalInput")?.select();
  });
}

function renderAccountInfo() {
  const root = document.getElementById("accountInfoContent");

  if (!root) return;

  if (!isAccountManager(appUserSession)) {
    root.innerHTML = `
      <div class="restricted-card">
        <p class="eyebrow">Admin Only</p>
        <h2>Account Administration is restricted.</h2>
        <p>Use My Account to view your own membership information.</p>
      </div>
    `;
    return;
  }

  const members = [...accountMembers].sort(sortMembers);
  const groups = statusOrder
    .map((status) => ({
      status,
      members: members.filter((member) => member.accountType === status)
    }))
    .filter((group) => group.members.length > 0);

  root.innerHTML = `
    <div class="account-page-heading">
      <div>
        <p class="eyebrow">Admin View</p>
        <h2>Membership Accounts</h2>
        <p>Search, review, and open member accounts. Details use a shared-account model: account data is shared, member data is per person.</p>
        ${dataSourceNotice()}
      </div>
      <div class="account-summary-strip">
        <span><strong>${members.length}</strong> members</span>
        <span><strong>${accounts.length}</strong> accounts</span>
        <span><strong>${members.filter((member) => member.accountType === "Open Gym Only").length}</strong> open gym</span>
      </div>
    </div>
    <label class="account-search">
      <span>Search accounts</span>
      <input id="accountSearch" type="search" placeholder="Name, account number, email, status" autocomplete="off" />
    </label>
    <div id="accountStatusGroups" class="account-status-groups">
      ${groups.map(renderAccountStatusGroup).join("")}
    </div>
  `;

  bindAccountInfoActions();
}

function renderOtherUsers() {
  const root = document.getElementById("otherUsersContent");

  if (!root) return;

  const currentMember = findMember(appUserSession.memberId);
  const account = accountForMember(currentMember);
  const members = otherUsersOnCurrentAccount();

  if (members.length === 0) {
    render("myAccount");
    return;
  }

  const groups = statusOrder
    .map((status) => ({
      status,
      members: members.filter((member) => member.accountType === status)
    }))
    .filter((group) => group.members.length > 0);

  root.innerHTML = `
    <div class="account-page-heading">
      <div>
        <p class="eyebrow">Shared Account</p>
        <h2>Other Users On My Account</h2>
        <p>Review the other people attached to ${escapeHtml(account?.accountNumber || "your account")}. These users share the same account number, while each person keeps their own member record.</p>
        ${dataSourceNotice()}
      </div>
      <div class="account-summary-strip">
        <span><strong>${members.length}</strong> other users</span>
        <span><strong>${escapeHtml(account?.accountNumber || "N/A")}</strong> account</span>
        <span><strong>${escapeHtml(currentMember?.accountType || "Member")}</strong></span>
      </div>
    </div>

    <label class="account-search">
      <span>Search users on my account</span>
      <input id="otherUsersSearch" type="search" placeholder="Name, email, phone, status" autocomplete="off" />
    </label>
    <div id="otherUsersStatusGroups" class="account-status-groups">
      ${groups.map(renderAccountStatusGroup).join("")}
    </div>
  `;

  bindOtherUsersActions();
}

function renderAccountStatusGroup(group) {
  return `
    <section class="status-panel" data-status-panel>
      <header class="status-panel-header">
        <h3>${escapeHtml(group.status)}</h3>
        <span>${group.members.length}</span>
      </header>
      <div class="member-card-list">
        ${group.members.map(renderMemberListCard).join("")}
      </div>
    </section>
  `;
}

function renderMemberListCard(member) {
  const account = accountForMember(member);
  const memberAccountNumber = displayAccountNumberForMember(member);
  const records = recordsForMember(member.id);
  const monthlySignIns = currentMonthRecords(records.timesheet, "signedInAt").length;
  const openBilling = records.billing
    .filter((item) => !item.postedToStripeAt)
    .reduce((total, item) => total + item.amountCents, 0);
  const searchValue = [
    member.memberName,
    member.accountType,
    member.emailAddress,
    member.phoneNumber,
    memberAccountNumber
  ].join(" ").toLowerCase();

  return `
    <button class="member-list-card" data-member-detail="${escapeHtml(member.id)}" data-search="${escapeHtml(searchValue)}" type="button">
      <span class="status-dot ${accountTypeTone(member.accountType)}" aria-hidden="true"></span>
      <span class="member-list-main">
        <strong>${escapeHtml(member.memberName)}</strong>
        <small>${escapeHtml(member.accountType)}</small>
      </span>
      <span class="member-list-meta">
        <strong>${escapeHtml(memberAccountNumber || "")}</strong>
        <small>${monthlySignIns} sign-ins this month</small>
      </span>
      <span class="member-list-actions" aria-hidden="true">
        <small>${openBilling > 0 ? formatCurrency(openBilling) : "No open balance"}</small>
        <span>Details</span>
      </span>
    </button>
  `;
}

function bindMemberDirectoryActions(searchId, returnRoute) {
  document.querySelectorAll("[data-member-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      appState.selectedMemberId = button.dataset.memberDetail;
      appState.detailReturnRoute = returnRoute;
      render("accountDetails");
    });
  });

  const search = document.getElementById(searchId);
  if (!search) return;

  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();

    document.querySelectorAll(".member-list-card").forEach((card) => {
      card.hidden = query !== "" && !card.dataset.search.includes(query);
    });

    document.querySelectorAll("[data-status-panel]").forEach((panel) => {
      const hasVisibleRows = [...panel.querySelectorAll(".member-list-card")]
        .some((card) => !card.hidden);
      panel.hidden = !hasVisibleRows;
    });
  });
}

function bindAccountInfoActions() {
  bindMemberDirectoryActions("accountSearch", "accountInfo");
}

function bindOtherUsersActions() {
  bindMemberDirectoryActions("otherUsersSearch", "otherUsers");
}

function renderAccountDetail(memberId) {
  const root = document.getElementById("accountDetailContent");
  const member = findMember(memberId);

  if (!root) return;

  if (!member) {
    root.innerHTML = `
      <section class="empty-state">
        <p>Account not found</p>
      </section>
    `;
    return;
  }

  const account = accountForMember(member);
  const memberAccountNumber = displayAccountNumberForMember(member);
  const canView = canUseAccountAdminTools()
    || member.id === appUserSession.memberId
    || member.accountId === appUserSession.accountId;

  if (!canView) {
    root.innerHTML = `
      <div class="restricted-card">
        <p class="eyebrow">Restricted</p>
        <h2>This account is not visible to your login.</h2>
      </div>
    `;
    return;
  }

  const records = recordsForMember(member.id);
  const monthlySignIns = currentMonthRecords(records.timesheet, "signedInAt").length;
  const openBilling = records.billing
    .filter((item) => !item.postedToStripeAt)
    .reduce((total, item) => total + item.amountCents, 0);
  const heaterMinutes = records.heater.reduce((total, entry) => {
    const minutes = durationMinutes(entry.startAt, entry.endAt);
    return total + (minutes || 0);
  }, 0);
  const canEditDetails = canEditMember(member);
  const canManageBilling = canManageBillingForMember(member);

  root.innerHTML = `
    <div class="member-detail-shell">
      <header class="detail-hero">
        <div class="detail-identity">
          <span class="status-dot status-dot-large ${accountTypeTone(member.accountType)}" aria-hidden="true"></span>
          <div>
            <p class="eyebrow">${escapeHtml(member.accountType)}</p>
            <h2>${escapeHtml(member.memberName)}</h2>
            <p>${escapeHtml(memberAccountNumber || "")} · ${escapeHtml(account?.membershipDetails || accessCopy(member.accountType))}</p>
          </div>
        </div>
        <div class="detail-quick-actions">
          <button data-detail-action="phone" data-member-id="${escapeAttribute(member.id)}" type="button">Phone Call</button>
          <button data-detail-action="text" data-member-id="${escapeAttribute(member.id)}" type="button">Text Message</button>
          <button data-detail-action="email" data-member-id="${escapeAttribute(member.id)}" type="button">Email</button>
          ${canManageBilling ? `<button data-detail-action="billing" data-member-id="${escapeAttribute(member.id)}" type="button">Manage Billing</button>` : ""}
          ${canEditDetails ? `<button class="edit-chip" data-detail-action="edit" data-member-id="${escapeAttribute(member.id)}" type="button">Edit</button>` : ""}
        </div>
        <div class="detail-stat-grid">
          <article>
            <span>Open Billing</span>
            <strong>${formatCurrency(openBilling)}</strong>
          </article>
          <article>
            <span>Sign-ins This Month</span>
            <strong>${monthlySignIns}</strong>
          </article>
          <article>
            <span>Guest Entries</span>
            <strong>${records.guests.length}</strong>
          </article>
          <article>
            <span>Heater Hours</span>
            <strong>${(heaterMinutes / 60).toFixed(1)}</strong>
          </article>
        </div>
      </header>

      <nav class="detail-tabs" aria-label="Account detail sections">
        <button class="detail-tab is-active" data-detail-panel="overview" type="button">Overview</button>
        <button class="detail-tab" data-detail-panel="billing" type="button">Billing</button>
        <button class="detail-tab" data-detail-panel="timesheet" type="button">Timesheet</button>
        <button class="detail-tab" data-detail-panel="guests" type="button">Guest Entries</button>
        <button class="detail-tab" data-detail-panel="heater" type="button">Heater Use</button>
      </nav>

      <div class="detail-panel-stack">
        <section class="detail-panel is-active" data-detail-panel-view="overview">
          ${renderOverviewPanel(member, account)}
        </section>
        <section class="detail-panel" data-detail-panel-view="billing">
          ${renderBillingPanel(records.billing)}
        </section>
        <section class="detail-panel" data-detail-panel-view="timesheet">
          ${renderTimesheetPanel(records.timesheet)}
        </section>
        <section class="detail-panel" data-detail-panel-view="guests">
          ${renderGuestPanel(records.guests)}
        </section>
        <section class="detail-panel" data-detail-panel-view="heater">
          ${renderHeaterPanel(records.heater)}
        </section>
      </div>
    </div>
  `;

  bindAccountDetailActions();
}

function renderOverviewPanel(member, account) {
  const memberAccountNumber = displayAccountNumberForMember(member);
  const memberDetails = [
    ["Member Name", member.memberName],
    ["Account Number", memberAccountNumber],
    ["Account Type", member.accountType],
    ["Phone Number", member.phoneNumber || "Not set"],
    ["Email Address", member.emailAddress || "Not set"],
    ["Billing Owner", member.isBillingOwner ? "Yes" : "No"],
    ["Day Pass Guest Entry", member.allowGuestEntry ? "Allowed" : "Not allowed"],
    ["Heater Use", member.allowHeaterUse ? "Allowed" : "Not allowed"]
  ];

  if (supportsMinorMemberFields) {
    memberDetails.push(
      ["Date of Birth", member.dateOfBirth ? formatShortDate(member.dateOfBirth) : "Not set"],
      ["Age", ageFromDateOfBirth(member.dateOfBirth) || "Not set"],
      ["Guardian", guardianNameForMember(member)],
      ["Independent Access", member.canAccessIndependently ? "Yes" : "No"]
    );
  }

  memberDetails.push(["Notes On Account", account?.notesOnAccount || "None"]);

  return `
    <div class="detail-card">
      <h3>Member</h3>
      ${renderDefinitionGrid(memberDetails)}
    </div>
  `;
}

function renderDefinitionGrid(items) {
  return `
    <dl class="definition-grid">
      ${items.map(([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value || "Not set")}</dd>
        </div>
      `).join("")}
    </dl>
  `;
}

function renderBillingPanel(items) {
  if (items.length === 0) return renderPanelEmpty("No billing line items yet.");

  return `
    <div class="detail-card">
      <h3>Billing Line Items</h3>
      <ol class="record-list">
        ${items.map((item) => `
          <li data-detail-log-type="billing" data-detail-log-id="${escapeAttribute(item.id)}" role="button" tabindex="0">
            <div>
              <strong>${escapeHtml(item.reason)}</strong>
              <span>${formatShortDateTime(item.createdAt)} · ${escapeHtml(billingStatusLabel(item))}</span>
            </div>
            <b>${formatCurrency(item.amountCents)}</b>
          </li>
        `).join("")}
      </ol>
    </div>
  `;
}

function renderTimesheetPanel(items) {
  if (items.length === 0) return renderPanelEmpty("No member sign-ins yet.");

  return `
    <div class="detail-card">
      <h3>Timesheet History</h3>
      <ol class="record-list">
        ${items.map((item) => `
          <li data-detail-log-type="timesheet" data-detail-log-id="${escapeAttribute(item.id)}" role="button" tabindex="0">
            <div>
              <strong>${formatShortDateTime(item.signedInAt)}</strong>
              <span>${formatDuration(item.signedInAt, item.signedOutAt)} · ${item.signedOutAt ? `Out ${formatShortDateTime(item.signedOutAt)}` : "Currently signed in"}</span>
            </div>
            <b>${escapeHtml(item.memberOrGuest)}</b>
          </li>
        `).join("")}
      </ol>
    </div>
  `;
}

function renderGuestPanel(items) {
  if (items.length === 0) return renderPanelEmpty("No guest entries for this member.");

  return `
    <div class="detail-card">
      <h3>Guest Entries</h3>
      <ol class="record-list">
        ${items.map((item) => `
          <li data-detail-log-type="timesheet" data-detail-log-id="${escapeAttribute(item.id)}" role="button" tabindex="0">
            <div>
              <strong>${escapeHtml(item.guestName)}</strong>
              <span>${formatShortDateTime(item.signedInAt)} · ${escapeHtml(item.dayPassOrOpenGym || "Day Pass")} · Liability ${item.liabilityAccepted ? "accepted" : "not accepted"}</span>
            </div>
            <b>${item.dayPassOrOpenGym === "Open Gym" ? "Free" : "10 free/mo"}</b>
          </li>
        `).join("")}
      </ol>
    </div>
  `;
}

function renderHeaterPanel(items) {
  if (items.length === 0) return renderPanelEmpty("No thermostat use records for this member.");

  return `
    <div class="detail-card">
      <h3>Thermostat Use</h3>
      <ol class="record-list">
        ${items.map((item) => `
          <li data-detail-log-type="heater" data-detail-log-id="${escapeAttribute(item.id)}" role="button" tabindex="0">
            <div>
              <strong>${escapeHtml(thermostatSystemLabel(item.systemType))}</strong>
              <span>${formatShortDate(item.usedOn)} · ${formatDuration(item.startAt, item.endAt)} · Set ${thermostatTempLabel(item.targetTemperatureF)}</span>
            </div>
            <b>${escapeHtml(heaterDisplayState(item))}</b>
          </li>
        `).join("")}
      </ol>
    </div>
  `;
}

function renderPanelEmpty(message) {
  return `
    <div class="detail-card detail-empty">
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function syncLocalMember(memberId, updates) {
  const index = accountMembers.findIndex((member) => member.id === memberId);

  if (index < 0) return;

  accountMembers[index] = {
    ...accountMembers[index],
    ...updates
  };
}

function removeLocalMember(memberId) {
  const index = accountMembers.findIndex((member) => member.id === memberId);

  if (index < 0) return;

  accountMembers.splice(index, 1);
}

function canEditMember(member) {
  return Boolean(canUseAccountAdminTools() || member?.id === appUserSession.memberId);
}

function showDetailActionMessage(message) {
  showAppNotice(message);
}

function showAppNotice(message, title = "Notice") {
  const existing = document.querySelector(".app-notice-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "app-notice-overlay";
  overlay.innerHTML = `
    <section class="app-notice-dialog" role="alertdialog" aria-modal="true" aria-label="${escapeAttribute(title)}">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(String(message || ""))}</p>
      <footer>
        <button class="app-notice-ok" type="button">OK</button>
      </footer>
    </section>
  `;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKeydown);
  };

  const onKeydown = (event) => {
    if (event.key === "Escape" || event.key === "Enter") {
      close();
    }
  };

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close();
    }
  });
  overlay.querySelector(".app-notice-ok")?.addEventListener("click", close);
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(overlay);
}

async function syncStripeMembershipForProfile(profile) {
  const canSync = profile?.is_billing_owner || profile?.account_type === "Account Manager";
  const token = currentAuthSession?.access_token || "";

  if (!canSync || !token) {
    return false;
  }

  try {
    const response = await fetch("/api/sync-stripe-membership", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        accountId: profile.account_id
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (response.status === 403 || response.status === 404) {
      return false;
    }

    if (!response.ok || payload.success === false) {
      console.warn("Stripe membership sync failed.", payload.error || response.status);
      return false;
    }

    return true;
  } catch (error) {
    console.warn("Stripe membership sync failed.", error);
    return false;
  }
}

async function openBillingPortalForMember(member, triggerButton) {
  if (!canManageBillingForMember(member)) {
    showDetailActionMessage("Billing is managed by the account owner.");
    return;
  }

  const token = currentAuthSession?.access_token || "";

  if (!token) {
    showAuthGate("Please sign in to manage billing.", "error");
    return;
  }

  const originalText = triggerButton?.textContent || "";

  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.textContent = "Opening...";
  }

  try {
    const response = await fetch("/api/member-portal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        accountId: member.accountId,
        returnPath: `${window.location.pathname}${window.location.search}`
      })
    });

    const payload = await response.json().catch(() => ({}));

    if (response.ok && payload.success && payload.url) {
      window.location.href = payload.url;
      return;
    }

    if (response.status === 404) {
      window.open(STRIPE_FALLBACK_PORTAL, "_blank", "noopener");
      return;
    }

    throw new Error(payload.error || "Could not open billing portal.");
  } catch (error) {
    showDetailActionMessage(error.message || "Could not open billing portal.");
  } finally {
    if (triggerButton) {
      triggerButton.disabled = false;
      triggerButton.textContent = originalText;
    }
  }
}

async function updateMemberContact(member, updates) {
  const client = await createSupabaseClient();
  const canUseAdminTools = canUseAccountAdminTools();

  if (!client) {
    throw new Error("App data is not available.");
  }

  const dbUpdates = {
    phone_number: updates.phoneNumber,
    email_address: updates.emailAddress
  };

  if (canUseAdminTools) {
    dbUpdates.member_name = updates.memberName;
    dbUpdates.account_type = updates.accountType || member.accountType;
    dbUpdates.allow_guest_entry = Boolean(updates.allowGuestEntry);
    dbUpdates.allow_heater_use = Boolean(updates.allowHeaterUse);

    if (supportsMinorMemberFields) {
      if (Object.prototype.hasOwnProperty.call(updates, "dateOfBirth")) {
        dbUpdates.date_of_birth = updates.dateOfBirth || null;
      }

      if (Object.prototype.hasOwnProperty.call(updates, "guardianMemberId")) {
        dbUpdates.guardian_member_id = updates.guardianMemberId || null;
      }

      if (Object.prototype.hasOwnProperty.call(updates, "canAccessIndependently")) {
        dbUpdates.can_access_independently = Boolean(updates.canAccessIndependently);
      }
    }
  }

  const { error } = await client
    .from("account_members")
    .update(dbUpdates)
    .eq("id", member.id);

  if (error) {
    if (
      updates.accountType === "Special Access Account"
      && String(error.message || "").toLowerCase().includes("membership_account_type")
    ) {
      throw new Error("Special Access Account is not added yet. Run supabase/add_special_access_account_type.sql first.");
    }

    throw error;
  }

  if (canUseAdminTools) {
    const { error: accountTypeError } = await client
      .from("account_members")
      .update({ account_type: updates.accountType || member.accountType })
      .eq("account_id", member.accountId);

    if (accountTypeError) {
      if (
        updates.accountType === "Special Access Account"
        && String(accountTypeError.message || "").toLowerCase().includes("membership_account_type")
      ) {
        throw new Error("Special Access Account is not added yet. Run supabase/add_special_access_account_type.sql first.");
      }

      throw accountTypeError;
    }
  }

  if (canUseAdminTools && updates.accountNumber) {
    const currentAccountNumber = displayAccountNumberForMember(member);
    const targetAccountNumber = String(updates.accountNumber || "").trim();

    if (targetAccountNumber && targetAccountNumber !== currentAccountNumber) {
      const token = currentAuthSession?.access_token || "";
      let moved = false;
      let apiErrorMessage = "";

      if (token) {
        try {
          const response = await fetch("/api/move-member-account", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
              memberId: member.id,
              targetAccountNumber
            })
          });

          const body = await response.json().catch(() => ({}));

          if (!response.ok || body.success === false) {
            apiErrorMessage = body.error || `Move endpoint failed (${response.status}).`;
          } else {
            moved = true;
          }
        } catch (error) {
          apiErrorMessage = error.message || "Move endpoint request failed.";
        }
      }

      if (!moved) {
        try {
          await moveMemberToAccountClientFallback(member, targetAccountNumber);
          moved = true;
        } catch (fallbackError) {
          throw new Error(fallbackError.message || apiErrorMessage || "Could not move member to account.");
        }
      }

      if (!moved) {
        throw new Error(apiErrorMessage || "Could not move member to account.");
      }
    }
  }

  if (canUseAdminTools && Object.prototype.hasOwnProperty.call(updates, "stripeCustomerId")) {
    const nextStripeCustomerId = String(updates.stripeCustomerId || "").trim();
    const currentStripeCustomerId = String(accountForMember(member)?.stripeCustomerId || "").trim();

    if (nextStripeCustomerId !== currentStripeCustomerId) {
      await updateAccountStripeCustomerId(member.accountId, nextStripeCustomerId);
      const accountIndex = accounts.findIndex((account) => account.id === member.accountId);
      if (accountIndex >= 0) {
        accounts[accountIndex] = {
          ...accounts[accountIndex],
          stripeCustomerId: nextStripeCustomerId
        };
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, "heaterPin")) {
    const nextHeaterPin = String(updates.heaterPin || "").trim();
    const currentHeaterPin = String(accountForMember(member)?.heaterPin || "").trim();

    if (nextHeaterPin !== currentHeaterPin) {
      await updateAccountHeaterPin(member.accountId, nextHeaterPin);
      const accountIndex = accounts.findIndex((account) => account.id === member.accountId);
      if (accountIndex >= 0) {
        accounts[accountIndex] = {
          ...accounts[accountIndex],
          heaterPin: nextHeaterPin
        };
      }
    }
  }

  if (member.id === appUserSession.memberId) {
    const metadata = currentAuthSession?.user?.user_metadata || {};
    const authUpdate = {
      data: {
        ...metadata,
        display_name: updates.memberName,
        email: updates.emailAddress,
        full_name: updates.memberName,
        member_name: updates.memberName,
        name: updates.memberName,
        phone: updates.phoneNumber,
        phone_number: updates.phoneNumber
      }
    };

    if (updates.emailAddress && updates.emailAddress !== String(currentAuthSession?.user?.email || "").trim().toLowerCase()) {
      authUpdate.email = updates.emailAddress;
    }

    const { error: authError } = await client.auth.updateUser(authUpdate);

    if (authError) {
      throw authError;
    }

    const sessionResult = await client.auth.getSession();
    currentAuthSession = sessionResult.data?.session || currentAuthSession;
    appState.currentUserEmail = currentAuthSession?.user?.email || updates.emailAddress;
  }

  const localMemberUpdates = {
    phoneNumber: updates.phoneNumber,
    emailAddress: updates.emailAddress
  };

  if (canUseAdminTools) {
    Object.assign(localMemberUpdates, {
      memberName: updates.memberName,
      accountType: updates.accountType || member.accountType,
      allowGuestEntry: Boolean(updates.allowGuestEntry),
      allowHeaterUse: Boolean(updates.allowHeaterUse)
    });

    if (supportsMinorMemberFields) {
      if (Object.prototype.hasOwnProperty.call(updates, "dateOfBirth")) {
        localMemberUpdates.dateOfBirth = updates.dateOfBirth || "";
      }

      if (Object.prototype.hasOwnProperty.call(updates, "guardianMemberId")) {
        localMemberUpdates.guardianMemberId = updates.guardianMemberId || "";
      }

      if (Object.prototype.hasOwnProperty.call(updates, "canAccessIndependently")) {
        localMemberUpdates.canAccessIndependently = Boolean(updates.canAccessIndependently);
      }
    }
  }

  syncLocalMember(member.id, localMemberUpdates);

  if (canUseAdminTools) {
    accountMembers.forEach((accountMember) => {
      if (accountMember.accountId === member.accountId) {
        syncLocalMember(accountMember.id, {
          accountType: updates.accountType || member.accountType
        });
      }
    });
  }

  refreshSessions(appState.authMemberId);
  updateDrawerIdentity();
}

async function updateAccountStripeCustomerId(accountId, stripeCustomerId) {
  const token = currentAuthSession?.access_token || "";

  if (!token) {
    throw new Error("Missing session token.");
  }

  const response = await fetch("/api/update-account-billing", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      accountId,
      stripeCustomerId: stripeCustomerId || null
    })
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not update Stripe customer ID.");
  }
}

async function updateAccountHeaterPin(accountId, heaterPin) {
  const token = currentAuthSession?.access_token || "";

  if (!token) {
    throw new Error("Missing session token.");
  }

  const response = await fetch("/api/update-account-heater-pin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      accountId,
      heaterPin: heaterPin || null
    })
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not update account heater PIN.");
  }
}

async function moveMemberToAccountClientFallback(member, targetAccountNumber) {
  const client = await createSupabaseClient();

  if (!client) {
    throw new Error("App data is not available.");
  }

  let targetAccountId = "";
  const existingAccountResult = await client
    .from("accounts")
    .select("id,account_number")
    .eq("account_number", targetAccountNumber)
    .maybeSingle();

  if (existingAccountResult.error) {
    throw existingAccountResult.error;
  }

  if (existingAccountResult.data?.id) {
    targetAccountId = existingAccountResult.data.id;
  } else {
    const createResult = await client
      .from("accounts")
      .insert({ account_number: targetAccountNumber })
      .select("id")
      .single();

    if (createResult.error) {
      throw createResult.error;
    }

    targetAccountId = createResult.data?.id || "";
  }

  if (!targetAccountId) {
    throw new Error("Could not resolve target account.");
  }

  if (member.isBillingOwner) {
    const billingOwnerResult = await client
      .from("account_members")
      .select("id")
      .eq("account_id", targetAccountId)
      .eq("is_billing_owner", true)
      .limit(1)
      .maybeSingle();

    if (billingOwnerResult.error) {
      throw billingOwnerResult.error;
    }

    if (billingOwnerResult.data) {
      throw new Error("Target account already has a billing owner. Move a non-billing-owner profile or reassign billing owner first.");
    }
  }

  const updateResult = await client
    .from("account_members")
    .update({ account_id: targetAccountId })
    .eq("id", member.id);

  if (updateResult.error) {
    throw updateResult.error;
  }
}

async function deleteSupabaseUserAccount(member) {
  const token = currentAuthSession?.access_token || "";

  if (!token) {
    throw new Error("Missing session token.");
  }

  const response = await fetch("/api/delete-user-account", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      memberId: member?.id || ""
    })
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not delete the full user account.");
  }
}

function openMemberEditDialog(member) {
  if (!canEditMember(member)) {
    showDetailActionMessage("You can view this account, but you cannot edit it.");
    return;
  }

  const canUseAdminTools = canUseAccountAdminTools();
  const canEditName = canUseAdminTools;
  const canDeleteUserAccount = Boolean(member.id) && canUseAdminTools && member.id !== appUserSession.memberId;
  const account = accountForMember(member);
  const guardianOptions = accountMembers
    .filter((candidate) => candidate.accountId === member.accountId && candidate.id !== member.id)
    .sort(sortMembers)
    .map((candidate) => `
      <option value="${escapeAttribute(candidate.id)}" ${candidate.id === member.guardianMemberId ? "selected" : ""}>${escapeHtml(candidate.memberName)}</option>
    `)
    .join("");
  const overlay = document.createElement("div");
  overlay.className = "member-edit-overlay";
  overlay.innerHTML = `
    <section class="member-edit-dialog" role="dialog" aria-modal="true" aria-label="Edit member">
      <header>
        <p class="eyebrow">Edit Member</p>
        <h2>${escapeHtml(member.memberName)}</h2>
      </header>

      <label>
        <span>Member Name</span>
        <input id="editMemberName" type="text" value="${escapeAttribute(member.memberName)}" ${canEditName ? "" : "disabled"} />
      </label>

      <label>
        <span>Phone Number</span>
        <input id="editMemberPhone" type="tel" value="${escapeAttribute(member.phoneNumber)}" inputmode="tel" />
      </label>

      <label>
        <span>Email Address</span>
        <input id="editMemberEmail" type="email" value="${escapeAttribute(member.emailAddress)}" inputmode="email" />
      </label>

      <label>
        <span>Shared Account Heater PIN</span>
        <input id="editAccountHeaterPin" type="password" value="${escapeAttribute(account?.heaterPin || "")}" inputmode="numeric" pattern="[0-9]*" maxlength="4" minlength="4" autocomplete="off" />
      </label>

      ${canEditName ? `
      <label>
        <span>Account Number</span>
        <input id="editAccountNumber" type="text" value="${escapeAttribute(displayAccountNumberForMember(member))}" />
      </label>
      <label>
        <span>Account Type</span>
        <select id="editMemberAccountType">
          ${accountTypeOptions.map((accountType) => `
            <option value="${escapeAttribute(accountType)}" ${accountType === member.accountType ? "selected" : ""}>${escapeHtml(accountType)}</option>
          `).join("")}
        </select>
      </label>
      <label>
        <span>Day Pass Guest Permission</span>
        <select id="editAllowGuestEntry">
          <option value="yes" ${member.allowGuestEntry ? "selected" : ""}>Yes</option>
          <option value="no" ${member.allowGuestEntry ? "" : "selected"}>No</option>
        </select>
      </label>
      ${supportsMinorMemberFields ? `
      <label>
        <span>Date of Birth</span>
        <input id="editDateOfBirth" type="date" value="${escapeAttribute(member.dateOfBirth || "")}" />
      </label>
      <label>
        <span>Guardian / Responsible Adult</span>
        <select id="editGuardianMemberId">
          <option value="" ${member.guardianMemberId ? "" : "selected"}>No guardian linked</option>
          ${guardianOptions}
        </select>
      </label>
      <label>
        <span>Can Access Independently</span>
        <select id="editCanAccessIndependently">
          <option value="yes" ${member.canAccessIndependently ? "selected" : ""}>Yes</option>
          <option value="no" ${member.canAccessIndependently ? "" : "selected"}>No</option>
        </select>
      </label>
      ` : ""}
      <label>
        <span>Heater Permission</span>
        <select id="editAllowHeaterUse">
          <option value="yes" ${member.allowHeaterUse ? "selected" : ""}>Yes</option>
          <option value="no" ${member.allowHeaterUse ? "" : "selected"}>No</option>
        </select>
      </label>
      <label>
        <span>Stripe Customer ID</span>
        <input id="editStripeCustomerId" type="text" value="${escapeAttribute(account?.stripeCustomerId || "")}" placeholder="cus_..." autocapitalize="off" autocomplete="off" spellcheck="false" />
      </label>
      ` : ""}

      <p id="editMemberResult" class="member-edit-result"></p>

      <footer>
        ${canDeleteUserAccount ? `<button class="member-edit-delete-user" type="button">Delete User Account</button>` : ""}
        <button class="member-edit-cancel" type="button">Cancel</button>
        <button class="member-edit-save" type="button">Save</button>
      </footer>
    </section>
  `;

  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", handleKeydown);
  };

  const setResult = (message, tone = "default") => {
    const result = overlay.querySelector("#editMemberResult");
    if (!result) return;
    result.textContent = message;
    result.dataset.tone = tone;
  };

  const saveButton = overlay.querySelector(".member-edit-save");
  const deleteUserAccountButton = overlay.querySelector(".member-edit-delete-user");
  const openDeleteConfirmDialog = ({
    title = `Delete ${member.memberName}?`,
    message = "This permanently removes this member record.",
    confirmLabel = "Delete"
  } = {}) => new Promise((resolve) => {
    const confirmOverlay = document.createElement("div");
    confirmOverlay.className = "member-delete-confirm-overlay";
    confirmOverlay.innerHTML = `
      <section class="member-delete-confirm-dialog" role="dialog" aria-modal="true" aria-label="Confirm member delete">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <footer>
          <button class="member-delete-confirm-cancel" type="button">Cancel</button>
          <button class="member-delete-confirm-accept" type="button">${escapeHtml(confirmLabel)}</button>
        </footer>
      </section>
    `;

    overlay.appendChild(confirmOverlay);

    const closeConfirm = (confirmed) => {
      confirmOverlay.remove();
      resolve(confirmed);
    };

    confirmOverlay.querySelector(".member-delete-confirm-cancel")?.addEventListener("click", () => closeConfirm(false));
    confirmOverlay.querySelector(".member-delete-confirm-accept")?.addEventListener("click", () => closeConfirm(true));
    confirmOverlay.addEventListener("click", (event) => {
      if (event.target === confirmOverlay) {
        closeConfirm(false);
      }
    });
  });
  const save = async () => {
    const memberName = String(overlay.querySelector("#editMemberName")?.value || "").trim();
    const phoneNumber = String(overlay.querySelector("#editMemberPhone")?.value || "").trim();
    const emailAddress = String(overlay.querySelector("#editMemberEmail")?.value || "").trim().toLowerCase();
    const accountNumber = String(overlay.querySelector("#editAccountNumber")?.value || displayAccountNumberForMember(member) || "").trim();
    const accountType = String(overlay.querySelector("#editMemberAccountType")?.value || member.accountType);
    const allowGuestEntry = String(overlay.querySelector("#editAllowGuestEntry")?.value || "no") === "yes";
    const allowHeaterUse = String(overlay.querySelector("#editAllowHeaterUse")?.value || "no") === "yes";
    const dateOfBirth = String(overlay.querySelector("#editDateOfBirth")?.value || "").trim();
    const guardianMemberId = String(overlay.querySelector("#editGuardianMemberId")?.value || "").trim();
    const canAccessIndependently = String(overlay.querySelector("#editCanAccessIndependently")?.value || "yes") === "yes";
    const stripeCustomerId = String(overlay.querySelector("#editStripeCustomerId")?.value || account?.stripeCustomerId || "").trim();
    const heaterPin = String(overlay.querySelector("#editAccountHeaterPin")?.value || "").trim();

    if (!memberName) {
      setResult("Member name is required.", "error");
      return;
    }

    if (canEditName && !accountNumber) {
      setResult("Account number is required.", "error");
      return;
    }

    if (heaterPin && !/^\d{4}$/.test(heaterPin)) {
      setResult("Shared account heater PIN must be 4 digits.", "error");
      return;
    }

    saveButton.disabled = true;
    setResult("Saving...");

    try {
      await updateMemberContact(member, {
        memberName,
        phoneNumber,
        emailAddress,
        accountType,
        allowGuestEntry,
        allowHeaterUse,
        ...(supportsMinorMemberFields && canEditName ? {
          dateOfBirth,
          guardianMemberId,
          canAccessIndependently
        } : {}),
        accountNumber,
        stripeCustomerId,
        heaterPin
      });

      setResult("Saved.", "success");
      close();
      window.setTimeout(() => {
        hydrateFromSupabase();
      }, 180);
    } catch (error) {
      setResult(error.message || "Could not save member.", "error");
    } finally {
      saveButton.disabled = false;
    }
  };

  overlay.querySelector(".member-edit-cancel")?.addEventListener("click", close);
  saveButton?.addEventListener("click", save);
  deleteUserAccountButton?.addEventListener("click", async () => {
    const confirmed = await openDeleteConfirmDialog({
      title: `Delete ${member.memberName}'s user account?`,
      message: "This permanently removes the member profile, the linked Supabase Auth user, and related account data.",
      confirmLabel: "Delete User Account"
    });
    if (!confirmed) return;

    deleteUserAccountButton.disabled = true;
    saveButton.disabled = true;
    setResult("Deleting full user account...");

    try {
      await deleteSupabaseUserAccount(member);
      close();
      render(appState.detailReturnRoute || "accountInfo");
      window.setTimeout(() => {
        hydrateFromSupabase();
      }, 180);
    } catch (error) {
      setResult(error.message || "Could not delete the full user account.", "error");
      deleteUserAccountButton.disabled = false;
      saveButton.disabled = false;
    }
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  const handleKeydown = (event) => {
    if (event.key === "Escape") {
      close();
    }

    if (event.key === "Enter" && event.target?.tagName === "INPUT") {
      save();
    }
  };

  document.addEventListener("keydown", handleKeydown);
  overlay.querySelector(canEditName ? "#editMemberName" : "#editMemberPhone")?.focus();
}

function handleDetailQuickAction(button) {
  const member = findMember(button.dataset.memberId);

  if (!member) {
    showDetailActionMessage("Member not found.");
    return;
  }

  if (button.dataset.detailAction === "phone") {
    const href = phoneHref(member.phoneNumber, "tel");

    if (!href) {
      showDetailActionMessage("No phone number is saved for this member.");
      return;
    }

    window.location.href = href;
    return;
  }

  if (button.dataset.detailAction === "text") {
    const href = phoneHref(member.phoneNumber, "sms");

    if (!href) {
      showDetailActionMessage("No phone number is saved for this member.");
      return;
    }

    window.location.href = href;
    return;
  }

  if (button.dataset.detailAction === "email") {
    const href = emailHref(member.emailAddress, "RORC");

    if (!href) {
      showDetailActionMessage("No email address is saved for this member.");
      return;
    }

    window.location.href = href;
    return;
  }

  if (button.dataset.detailAction === "billing") {
    openBillingPortalForMember(member, button);
    return;
  }

  if (button.dataset.detailAction === "edit") {
    openMemberEditDialog(member);
  }
}

function bindAccountDetailActions() {
  document.querySelectorAll("[data-detail-action]").forEach((button) => {
    button.addEventListener("click", () => handleDetailQuickAction(button));
  });

  bindDetailLogOpenActions();

  document.querySelectorAll(".detail-tab").forEach((button) => {
    button.addEventListener("click", () => {
      const panelName = button.dataset.detailPanel;

      document.querySelectorAll(".detail-tab").forEach((tab) => {
        tab.classList.toggle("is-active", tab === button);
      });

      document.querySelectorAll("[data-detail-panel-view]").forEach((panel) => {
        panel.classList.toggle("is-active", panel.dataset.detailPanelView === panelName);
      });
    });
  });
}

function bindDetailLogOpenActions() {
  document.querySelectorAll("[data-detail-log-id]").forEach((row) => {
    const open = () => {
      const recordType = String(row.dataset.detailLogType || "").trim();
      const recordId = String(row.dataset.detailLogId || "").trim();
      if (!recordType || !recordId) return;
      openRecordDetail(recordType, recordId);
    };

    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

function bindHeaterRecordsActions() {
  bindDetailLogOpenActions();

  document.querySelector("[data-change-thermostat-temp]")?.addEventListener("click", () => {
    changeActiveThermostatTemperature().catch((error) => {
      clearThermostatActionFeedback();
      if (appState.currentRoute === "heaterRecords") render("heaterRecords");
      showDetailActionMessage(error.message || "Could not change thermostat temperature.");
    });
  });

  document.querySelector("[data-turn-thermostat-off]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const systemType = String(event.currentTarget?.dataset?.turnThermostatOff || "").trim();
    const entryId = String(event.currentTarget?.dataset?.turnThermostatEntryId || "").trim();
    turnHeaterOffActiveEntry(systemType, entryId).catch((error) => {
      clearThermostatActionFeedback();
      if (appState.currentRoute === "heaterRecords") render("heaterRecords");
      showDetailActionMessage(error.message || "Could not turn thermostat off.");
    });
  });

  const confirm = document.getElementById("heaterConfirm");
  const closeButton = document.querySelector("[data-heater-confirm-close]");
  const acceptButton = document.querySelector("[data-heater-confirm-accept]");
  const confirmSystem = document.querySelector("[data-confirm-thermostat-system]");

  if (!confirm || !closeButton || !acceptButton) return;

  const openConfirm = (systemType = "") => {
    if (!hasAnyThermostatSystemEnabled()) {
      showDetailActionMessage("Thermostat use is currently disabled by admin settings.");
      return;
    }
    if (systemType === "heat" || systemType === "ac") {
      if (!isThermostatSystemEnabled(systemType)) {
        showDetailActionMessage(`${thermostatSystemLabel(systemType)} is currently disabled by admin settings.`);
        return;
      }
      appState.pendingThermostatSystem = systemType;
    }
    confirmSystem?.querySelectorAll("[data-confirm-system]").forEach((button) => {
      const system = button.dataset.confirmSystem === "ac" ? "ac" : "heat";
      const enabled = isThermostatSystemEnabled(system);
      button.classList.toggle("is-disabled", !enabled);
      button.setAttribute("aria-disabled", enabled ? "false" : "true");
      button.classList.toggle("is-selected", button.dataset.confirmSystem === appState.pendingThermostatSystem);
    });
    const confirmMessage = confirm.querySelector(".confirm-dialog p");
    const selectedLabel = appState.pendingThermostatSystem === "ac" ? "AC" : "Heat";
    const costCopy = appState.pendingThermostatSystem === "ac"
      ? "AC costs $2 per hour and is billed monthly."
      : "Heat costs $13 per hour and is billed monthly.";
    if (confirmMessage) {
      confirmMessage.innerHTML = `Confirm ${selectedLabel}<br /><span>${escapeHtml(costCopy)}</span>`;
    }
    if (confirmSystem) {
      confirmSystem.hidden = systemType === "heat" || systemType === "ac";
    }
    acceptButton.textContent = "CONFIRM";
    confirm.hidden = false;
  };

  document.querySelectorAll("[data-open-thermostat-system]").forEach((card) => {
    const openFromCard = () => openConfirm(card.dataset.openThermostatSystem);
    card.addEventListener("click", openFromCard);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openFromCard();
      }
    });
  });

  confirmSystem?.querySelectorAll("[data-confirm-system]").forEach((button) => {
    button.addEventListener("click", () => {
      const selectedType = button.dataset.confirmSystem === "ac" ? "ac" : "heat";
      if (!isThermostatSystemEnabled(selectedType)) return;
      appState.pendingThermostatSystem = selectedType;
      confirmSystem.querySelectorAll("[data-confirm-system]").forEach((segment) => {
        segment.classList.toggle("is-selected", segment === button);
      });
    });
  });

  closeButton.addEventListener("click", () => {
    confirm.hidden = true;
  });

  acceptButton.addEventListener("click", () => {
    const selectedSystem = appState.pendingThermostatSystem
      || confirmSystem?.querySelector("[data-confirm-system].is-selected")?.dataset.confirmSystem
      || "";
    if (!["heat", "ac"].includes(selectedSystem)) {
      showDetailActionMessage("Select Heat or AC before starting.");
      return;
    }
    if (!isThermostatSystemEnabled(selectedSystem)) {
      showDetailActionMessage(`${thermostatSystemLabel(selectedSystem)} is currently disabled by admin settings.`);
      return;
    }

    confirm.hidden = true;
    appState.pendingThermostatSystem = selectedSystem;
    render("heaterForm");
  });

  confirm.addEventListener("click", (event) => {
    if (event.target === confirm) {
      confirm.hidden = true;
    }
  });
}

function populateHeaterForm() {
  const heaterDate = document.getElementById("heaterDate");

  if (heaterDate) {
    heaterDate.value = formatDateOnly(new Date());
  }

  const systemSegments = document.querySelectorAll('.heater-use-screen [aria-label="Thermostat system"] .segment');
  if (!hasAnyThermostatSystemEnabled()) {
    appState.pendingThermostatSystem = "";
    systemSegments.forEach((segment) => {
      segment.classList.remove("is-selected");
    });
    applyThermostatSystemAccessToHeaterForm();
    const saveButton = document.querySelector(".heater-use-screen .save-action");
    if (saveButton) saveButton.disabled = true;
    showDetailActionMessage("Thermostat use is currently disabled by admin settings.");
    return;
  }
  const saveButton = document.querySelector(".heater-use-screen .save-action");
  if (saveButton) saveButton.disabled = false;

  const preferredSystem = appState.pendingThermostatSystem === "ac" ? "ac" : "heat";
  const selectedSystem = isThermostatSystemEnabled(preferredSystem)
    ? preferredSystem
    : (thermostatSystemAccess.heatEnabled ? "heat" : "ac");
  appState.pendingThermostatSystem = selectedSystem;

  systemSegments.forEach((segment) => {
    segment.classList.toggle("is-selected", segment.dataset.thermostatSystem === selectedSystem);
  });
  applyThermostatSystemAccessToHeaterForm();

  const turnHeaterSegments = document.querySelectorAll('.heater-use-screen [aria-label="Turn thermostat on"] .segment');
  turnHeaterSegments.forEach((segment, index) => {
    segment.classList.toggle("is-selected", index === 0);
  });

  const costSegments = document.querySelectorAll('.heater-use-screen [aria-label="Thermostat cost accepted"] .segment');
  costSegments.forEach((segment) => {
    segment.classList.remove("is-selected");
  });

  const groupPaySegments = document.querySelectorAll('.heater-use-screen [aria-label="Group pay"] .segment');
  groupPaySegments.forEach((segment) => {
    segment.classList.toggle("is-selected", segment.dataset.heaterGroupPay === "N");
  });

  const timerEnabledSegments = document.querySelectorAll('.heater-use-screen [aria-label="Add timer"] .segment');
  timerEnabledSegments.forEach((segment) => {
    segment.classList.toggle("is-selected", segment.dataset.heaterTimerEnabled === "N");
  });

  const timerModeSegments = document.querySelectorAll('.heater-use-screen [aria-label="Timer type"] .segment');
  timerModeSegments.forEach((segment, index) => {
    segment.classList.toggle("is-selected", index === 0);
  });

  const heaterPin = document.getElementById("heaterPin");
  if (heaterPin) {
    heaterPin.value = "";
  }

  const timerDuration = document.getElementById("heaterTimerDuration");
  if (timerDuration) {
    timerDuration.value = "15";
  }

  const timerUntil = document.getElementById("heaterTimerUntil");
  if (timerUntil) {
    const inTwoHours = new Date(Date.now() + (2 * 60 * 60 * 1000));
    timerUntil.value = `${String(inTwoHours.getHours()).padStart(2, "0")}:${String(inTwoHours.getMinutes()).padStart(2, "0")}`;
  }

  updateHeaterGroupPayFields();
  updateHeaterTimerFields();
  updateThermostatSystemFields();
}

function populateMemberSignIn() {
  const input = document.getElementById("memberNameSelect");
  const dateTimeIn = document.getElementById("dateTimeIn");

  if (!input || !dateTimeIn) return;

  dateTimeIn.value = formatDateTime(new Date());
  setMultiMemberPickerValue(input.id, selectedMemberIdsFromInput(input));
}

function populateGuestSignIn() {
  const input = document.getElementById("guestMemberSelect");
  const dateTimeIn = document.getElementById("guestDateTimeIn");
  const recentGuests = document.getElementById("recentGuestNames");

  if (!input || !dateTimeIn) return;

  dateTimeIn.value = formatDateTime(new Date());
  setMemberPickerValue(input.id, input.value);

  if (recentGuests) {
    const threshold = Date.now() - (24 * 60 * 60 * 1000);
    const recentNames = [...new Set(
      timesheetEntries
        .filter((entry) => (
          entry.memberOrGuest === "Guest"
          && entry.guestName
          && new Date(entry.signedInAt).getTime() >= threshold
        ))
        .map((entry) => String(entry.guestName || "").trim())
        .filter(Boolean)
    )].slice(0, 30);

    recentGuests.innerHTML = recentNames
      .map((name) => `<option value="${escapeAttribute(name)}"></option>`)
      .join("");
  }
}

function updateOpenGymWarning(selectedButton) {
  const warning = document.getElementById("openGymWarning");

  if (!warning) return;

  warning.hidden = selectedButton.textContent.trim() !== "Open Gym" || isOpenGymWindow(new Date());
}

function applyThermostatSystemAccessToHeaterForm() {
  const systemSegments = document.querySelectorAll('.heater-use-screen [data-thermostat-system]');
  systemSegments.forEach((segment) => {
    const systemType = segment.dataset.thermostatSystem === "ac" ? "ac" : "heat";
    const enabled = isThermostatSystemEnabled(systemType);
    segment.classList.toggle("is-disabled", !enabled);
    segment.setAttribute("aria-disabled", enabled ? "false" : "true");
  });
}

function updateHeaterGroupPayFields(selectedButton) {
  const systemType = document.querySelector("[data-thermostat-system].is-selected")?.dataset.thermostatSystem || "heat";
  const forceSingleResponsible = systemType === "ac";
  const selectedValue = selectedButton?.dataset.heaterGroupPay
    || document.querySelector("[data-heater-group-pay].is-selected")?.dataset.heaterGroupPay
    || "";
  const singleField = document.getElementById("heaterResponsiblePartyField");
  const multiField = document.getElementById("heaterResponsiblePartiesField");

  if (!singleField || !multiField) return;

  singleField.hidden = forceSingleResponsible ? false : selectedValue !== "N";
  multiField.hidden = forceSingleResponsible ? true : selectedValue !== "Y";

  if (forceSingleResponsible) {
    setMultiMemberPickerValue("heaterResponsibleMembers", []);
  } else if (selectedButton && selectedValue === "N") {
    setMultiMemberPickerValue("heaterResponsibleMembers", []);
  } else if (selectedButton && selectedValue === "Y") {
    setMemberPickerValue("heaterResponsibleMember", "");
    const heaterPin = document.getElementById("heaterPin");
    if (heaterPin) {
      heaterPin.value = "";
    }
  }
}

function updateThermostatSystemFields(selectedButton) {
  const requestedSystemType = selectedButton?.dataset.thermostatSystem
    || document.querySelector("[data-thermostat-system].is-selected")?.dataset.thermostatSystem
    || "heat";
  const systemType = isThermostatSystemEnabled(requestedSystemType)
    ? requestedSystemType
    : (thermostatSystemAccess.heatEnabled ? "heat" : "ac");
  const isAc = systemType === "ac";
  const targetTemp = document.getElementById("thermostatTargetTemp");
  const costCopy = document.getElementById("thermostatCostCopy");
  const groupPayField = document.querySelector('.heater-use-screen [aria-label="Group pay"]')?.closest(".segmented-field");
  const heaterPinField = document.querySelector(".heater-pin-field");
  const allowedRange = thermostatTemperatureRange(systemType);

  if (targetTemp) {
    [...targetTemp.options].forEach((option) => {
      const value = Number(option.value);
      option.disabled = Number.isFinite(value) && value < allowedRange.min;
    });
  }

  if (targetTemp && (!selectedButton || selectedButton.dataset.thermostatSystem)) {
    const selectedValue = Number(targetTemp.value);
    if (!Number.isFinite(selectedValue) || selectedValue < allowedRange.min || selectedValue > allowedRange.max) {
      targetTemp.value = isAc ? "66" : "74";
    }
  }

  if (costCopy) {
    costCopy.innerHTML = isAc
      ? "AC costs $2 per hour and is billed monthly.<mark>*</mark>"
      : "Heat costs $13 per hour and is billed monthly.<mark>*</mark>";
  }

  if (groupPayField) {
    groupPayField.hidden = isAc;
  }

  if (heaterPinField) {
    heaterPinField.hidden = isAc;
  }

  if (isAc) {
    document.querySelectorAll("[data-heater-group-pay]").forEach((segment) => {
      segment.classList.toggle("is-selected", segment.dataset.heaterGroupPay === "N");
    });
  }

  document.querySelectorAll("[data-thermostat-system]").forEach((segment) => {
    if (segment.dataset.thermostatSystem === systemType) {
      segment.classList.add("is-selected");
    } else {
      segment.classList.remove("is-selected");
    }
  });

  updateHeaterGroupPayFields();
}

function updateHeaterTimerFields(selectedButton) {
  const timerEnabledValue = selectedButton?.dataset.heaterTimerEnabled
    || document.querySelector("[data-heater-timer-enabled].is-selected")?.dataset.heaterTimerEnabled
    || "N";
  const optionsField = document.getElementById("heaterTimerOptionsField");
  const durationField = document.getElementById("heaterTimerDurationField");
  const untilField = document.getElementById("heaterTimerUntilField");
  if (!optionsField || !durationField || !untilField) return;

  const enabled = timerEnabledValue === "Y";
  optionsField.hidden = !enabled;
  if (!enabled) return;

  const mode = selectedButton?.dataset.heaterTimerMode
    || document.querySelector("[data-heater-timer-mode].is-selected")?.dataset.heaterTimerMode
    || "duration";
  durationField.hidden = mode !== "duration";
  untilField.hidden = mode !== "until";
}

function openTimesheetCount() {
  return timesheetEntries.filter((entry) => !entry.signedOutAt).length;
}

function parseTimeStringToMinutes(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length < 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return (hours * 60) + minutes;
}

function minuteOfDayLocal(date) {
  return (date.getHours() * 60) + date.getMinutes();
}

function isWithinTimeWindow(nowMinutes, startMinutes, endMinutes) {
  if (startMinutes === null || endMinutes === null) return true;
  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

function canMemberSignInNow(member, signedInAt) {
  const type = canonicalAccountType(member?.accountType);
  const policy = accountTypePolicies[type] || defaultAccountTypePolicies()[type];

  if (!member) {
    return { allowed: false, reason: "Member not found." };
  }

  if (!policy?.canSignIn) {
    return { allowed: false, reason: `${type} is temporarily restricted from sign-in.` };
  }

  if (policy.bypassTimeWindows) {
    return { allowed: true, reason: "" };
  }

  const weekday = signedInAt.getDay();
  const allowedDays = Array.isArray(policy.allowedDays) ? policy.allowedDays : [];
  if (allowedDays.length && !allowedDays.includes(weekday)) {
    return { allowed: false, reason: `${type} cannot sign in on this day.` };
  }

  const nowMinutes = minuteOfDayLocal(signedInAt);
  const startMinutes = parseTimeStringToMinutes(policy.allowedStartTime);
  const endMinutes = parseTimeStringToMinutes(policy.allowedEndTime);
  if (!isWithinTimeWindow(nowMinutes, startMinutes, endMinutes)) {
    return { allowed: false, reason: `${type} is outside its allowed sign-in time window.` };
  }

  return { allowed: true, reason: "" };
}

function isEligibleForFirstSignInRule(member, signedInAt, wasNoOneSignedIn) {
  if (!wasNoOneSignedIn || !member) return false;
  return canMemberSignInNow(member, signedInAt).allowed;
}

async function triggerGymLightsOnSequence(memberName) {
  const payload = { memberName };
  const response = await fetch("/api/gym-lights-on-sequence", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Gym lights on sequence failed.");
  }
}

async function triggerGymLightsOffSequence(memberName, visitDurationMinutes) {
  const payload = { memberName, visitDurationMinutes };
  const response = await fetch("/api/gym-lights-off-sequence", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Gym lights off sequence failed.");
  }
}

async function loadGymLightsMode() {
  const token = currentAuthSession?.access_token || "";
  if (!token) return { mode: "full" };
  const response = await fetch("/api/gym-lights-mode", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not load gym lights mode.");
  }
  return body.settings || { mode: "full" };
}

async function saveGymLightsMode(mode) {
  const token = currentAuthSession?.access_token || "";
  const response = await fetch("/api/gym-lights-mode", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ mode })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not change gym lights mode.");
  }
  return body.settings || { mode };
}

async function refreshGymLightsMode({ rerender = false, force = false } = {}) {
  if (gymLightsModeLoading) return;
  const isStale = (Date.now() - gymLightsModeFetchedAt) > 15000;
  if (!force && !isStale) return;
  gymLightsModeLoading = true;
  try {
    const settings = await loadGymLightsMode();
    gymLightsMode = settings.mode === "half" ? "half" : "full";
    gymLightsModeFetchedAt = Date.now();
    if (rerender && appState.currentRoute === "currentlySignedIn") {
      renderCurrentlySignedIn();
    }
  } catch (error) {
    console.warn("Could not refresh gym lights mode.", error);
  } finally {
    gymLightsModeLoading = false;
  }
}

async function setGymLightsMode(mode) {
  const targetMode = mode === "half" ? "half" : "full";
  const settings = await saveGymLightsMode(targetMode);
  gymLightsMode = settings.mode === "half" ? "half" : "full";
  gymLightsModeFetchedAt = Date.now();
}

async function saveMemberSignIn() {
  const memberInput = document.getElementById("memberNameSelect");
  const saveButton = document.querySelector(".member-sign-in-screen .save-action");
  const selectedMemberIds = selectedMemberIdsFromInput(memberInput);

  if (selectedMemberIds.length === 0) {
    showDetailActionMessage("Select at least one member.");
    return;
  }

  const uniqueMemberIds = [...new Set(selectedMemberIds)];
  const signedInAtDate = new Date();
  const wasNoOneSignedIn = openTimesheetCount() === 0;
  const blockedMembers = uniqueMemberIds
    .map((memberId) => {
      const member = findMember(memberId);
      const validation = canMemberSignInNow(member, signedInAtDate);
      return { member, validation };
    })
    .filter(({ validation }) => !validation.allowed);

  if (blockedMembers.length > 0) {
    const firstBlocked = blockedMembers[0];
    const name = firstBlocked.member?.memberName || "Selected member";
    showDetailActionMessage(`${name}: ${firstBlocked.validation.reason}`);
    return;
  }

  const firstValidMember = uniqueMemberIds
    .map((memberId) => findMember(memberId))
    .find((member) => isEligibleForFirstSignInRule(member, signedInAtDate, wasNoOneSignedIn));
  const alreadySignedIn = uniqueMemberIds.filter((memberId) => (
    timesheetEntries.some((entry) => (
      entry.memberOrGuest === "Member"
      && entry.memberId === memberId
      && !entry.signedOutAt
    ))
  ));

  if (alreadySignedIn.length > 0) {
    const names = alreadySignedIn
      .map((memberId) => findMember(memberId)?.memberName || "Member")
      .join(", ");
    showDetailActionMessage(`${names} already signed in.`);
    return;
  }

  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
  }

  try {
    const rows = uniqueMemberIds.map((memberId) => ({
      member_or_guest: "Member",
      member_id: memberId,
      signed_in_at: signedInAtDate.toISOString()
    }));
    let createdEntries = [];

    if (canUsePrivilegedTimesheetApi()) {
      createdEntries = await insertPrivilegedTimesheetEntries(rows);
    } else {
      const client = await createSupabaseClient();

      if (!client) {
        throw new Error("App data is not available.");
      }

      const { data, error } = await client
        .from("timesheet_entries")
        .insert(rows)
        .select("*");

      if (error) {
        throw error;
      }

      createdEntries = data || [];
    }

    upsertLocalTimesheetEntries(createdEntries);
    render("currentlySignedIn");

    if (firstValidMember) {
      triggerGymLightsOnSequence(firstValidMember.memberName).catch((sequenceError) => {
        console.warn("Gym lights on sequence failed.", sequenceError);
      });
    }
  } catch (error) {
    showDetailActionMessage(error.message || "Could not save member sign-in.");
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "Save";
    }
  }
}

async function saveGuestSignIn() {
  const form = document.querySelector(".guest-sign-in-screen");
  const saveButton = form?.querySelector(".save-action");
  const guestName = String(document.getElementById("guestNameInput")?.value || "").trim();
  const memberEnteredWithId = String(document.getElementById("guestMemberSelect")?.value || "").trim();
  const passType = String(form?.querySelector('[aria-label="Guest pass type"] .segment.is-selected')?.textContent || "").trim();
  const liabilityValue = String(form?.querySelector('[aria-label="Liability accepted"] .segment.is-selected')?.textContent || "").trim();
  const liabilityAccepted = liabilityValue === "Y";

  if (!guestName) {
    showDetailActionMessage("Guest name is required.");
    return;
  }

  if (!memberEnteredWithId) {
    showDetailActionMessage("Select the member entered with.");
    return;
  }

  if (!["Day Pass", "Open Gym"].includes(passType)) {
    showDetailActionMessage("Select Day Pass or Open Gym.");
    return;
  }

  if (!["Y", "N"].includes(liabilityValue)) {
    showDetailActionMessage("Select liability accepted: Y or N.");
    return;
  }

  if (!liabilityAccepted) {
    showDetailActionMessage("Liability must be accepted to sign in a guest.");
    return;
  }

  if (passType === "Open Gym" && !isOpenGymWindow(new Date())) {
    showDetailActionMessage("Open Gym is only available Tuesday and Thursday nights 6pm to 8pm.");
    return;
  }

  const sponsorMember = findMember(memberEnteredWithId);
  const sponsorValidation = canMemberSignInNow(sponsorMember, new Date());
  if (!sponsorValidation.allowed) {
    showDetailActionMessage(`${sponsorMember?.memberName || "Selected member"}: ${sponsorValidation.reason}`);
    return;
  }

  if (passType !== "Open Gym" && !sponsorMember?.allowGuestEntry) {
    showDetailActionMessage(`${sponsorMember?.memberName || "Selected member"} cannot bring Day Pass guests outside Open Gym.`);
    return;
  }

  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
  }

  try {
    const nowIso = new Date().toISOString();
    const wasNoOneSignedIn = openTimesheetCount() === 0;
    const sponsorSignedIn = timesheetEntries.some((entry) => (
      entry.memberOrGuest === "Member"
      && entry.memberId === memberEnteredWithId
      && !entry.signedOutAt
    ));
    const rows = [];

    if (!sponsorSignedIn) {
      rows.push({
        member_or_guest: "Member",
        member_id: memberEnteredWithId,
        signed_in_at: nowIso
      });
    }

    rows.push({
      member_or_guest: "Guest",
      guest_name: guestName,
      day_pass_or_open_gym: passType,
      member_entered_with_id: memberEnteredWithId,
      liability_accepted: true,
      signed_in_at: nowIso
    });
    let createdEntries = [];

    if (canUsePrivilegedTimesheetApi()) {
      createdEntries = await insertPrivilegedTimesheetEntries(rows);
    } else {
      const client = await createSupabaseClient();

      if (!client) {
        throw new Error("App data is not available.");
      }

      const { data, error } = await client
        .from("timesheet_entries")
        .insert(rows)
        .select("*");

      if (error) {
        throw error;
      }

      createdEntries = data || [];
    }

    upsertLocalTimesheetEntries(createdEntries);
    render("currentlySignedIn");

    if (wasNoOneSignedIn && !sponsorSignedIn && sponsorMember) {
      triggerGymLightsOnSequence(sponsorMember.memberName).catch((sequenceError) => {
        console.warn("Gym lights on sequence failed.", sequenceError);
      });
    }
  } catch (error) {
    showDetailActionMessage(error.message || "Could not save guest sign-in.");
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "Save";
    }
  }
}

async function saveHeaterUse() {
  const form = document.querySelector(".heater-use-screen");
  const saveButton = form?.querySelector(".save-action");

  if (!form) return;
  if (!hasAnyThermostatSystemEnabled()) {
    showDetailActionMessage("Thermostat use is currently disabled by admin settings.");
    return;
  }

  const systemType = String(form.querySelector('[aria-label="Thermostat system"] .segment.is-selected')?.dataset.thermostatSystem || "heat").trim();
  const turnHeaterOn = "On";
  const targetTemperatureF = Number(document.getElementById("thermostatTargetTemp")?.value || 0);
  const costAccepted = String(form.querySelector('[aria-label="Thermostat cost accepted"] .segment.is-selected')?.dataset.thermostatCostAccepted || "N").trim() === "Y";
  const groupPayValue = systemType === "ac"
    ? "N"
    : String(form.querySelector('[aria-label="Group pay"] .segment.is-selected')?.dataset.heaterGroupPay || "").trim();
  const timerEnabledValue = String(form.querySelector('[aria-label="Add timer"] .segment.is-selected')?.dataset.heaterTimerEnabled || "N").trim();
  const timerMode = String(form.querySelector('[aria-label="Timer type"] .segment.is-selected')?.dataset.heaterTimerMode || "duration").trim();
  const timerDurationMinutes = Number(document.getElementById("heaterTimerDuration")?.value || 0);
  const timerUntilValue = String(document.getElementById("heaterTimerUntil")?.value || "").trim();
  const note = String(form.querySelector("textarea")?.value || "").trim();
  const singleResponsibleMemberId = String(document.getElementById("heaterResponsibleMember")?.value || "").trim();
  const multiResponsibleMemberIds = selectedMemberIdsFromInput(document.getElementById("heaterResponsibleMembers"));
  const heaterPin = String(document.getElementById("heaterPin")?.value || "").trim();

  if (!["heat", "ac"].includes(systemType)) {
    showDetailActionMessage("Select Heat or AC.");
    return;
  }
  if (!isThermostatSystemEnabled(systemType)) {
    showDetailActionMessage(`${thermostatSystemLabel(systemType)} is currently disabled by admin settings.`);
    return;
  }

  const allowedRange = thermostatTemperatureRange(systemType);
  if (turnHeaterOn === "On" && (!Number.isFinite(targetTemperatureF) || targetTemperatureF < allowedRange.min || targetTemperatureF > allowedRange.max)) {
    showDetailActionMessage("Select a desired temperature.");
    return;
  }

  if (turnHeaterOn === "On" && !costAccepted) {
    showDetailActionMessage(systemType === "ac"
      ? "Accept the AC use acknowledgement before turning it on."
      : "Accept the heat cost acknowledgement before turning it on.");
    return;
  }

  if (!["N", "Y"].includes(groupPayValue)) {
    showDetailActionMessage("Select Group Pay: N or Y.");
    return;
  }

  if (groupPayValue === "N" && !singleResponsibleMemberId) {
    showDetailActionMessage("Select a responsible party.");
    return;
  }

  if (groupPayValue === "Y" && multiResponsibleMemberIds.length === 0) {
    showDetailActionMessage("Select at least one responsible party.");
    return;
  }

  const timerEnabled = timerEnabledValue === "Y";
  if (timerEnabled) {
    if (timerMode === "duration" && (!Number.isFinite(timerDurationMinutes) || timerDurationMinutes <= 0)) {
      showDetailActionMessage("Select a timer length.");
      return;
    }
    if (timerMode === "until" && !/^\d{2}:\d{2}$/.test(timerUntilValue)) {
      showDetailActionMessage("Select a valid turn-off time.");
      return;
    }
  }

  if (systemType === "heat" && groupPayValue === "N" && !/^\d{4}$/.test(heaterPin)) {
    showDetailActionMessage("Enter the 4-digit heater PIN.");
    return;
  }

  const client = await createSupabaseClient();

  if (!client) {
    showDetailActionMessage("App data is not available.");
    return;
  }

  const systemLabel = thermostatSystemLabel(systemType);
  setThermostatActionFeedback("start", systemType, `Starting ${systemLabel}. This can take a moment.`);

  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = `Starting ${systemLabel}...`;
  }

  try {
    const groupPay = groupPayValue === "Y";
    const responsibleMemberId = groupPay ? (multiResponsibleMemberIds[0] || null) : singleResponsibleMemberId;
    const usedOn = formatDateOnly(new Date());
    const now = new Date();
    const startAtIso = now.toISOString();
    const timerStart = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:00`;
    let timerStop = null;

    if (timerEnabled && timerMode === "duration") {
      const stopDate = new Date(now.getTime() + (timerDurationMinutes * 60000));
      timerStop = `${String(stopDate.getHours()).padStart(2, "0")}:${String(stopDate.getMinutes()).padStart(2, "0")}:00`;
    } else if (timerEnabled && timerMode === "until") {
      timerStop = `${timerUntilValue}:00`;
    }

    if (systemType === "heat" && !groupPay && responsibleMemberId) {
      await verifyHeaterPin(responsibleMemberId, heaterPin);
    }

    const { data: createdEntry, error } = await client
      .from("heater_use_entries")
      .insert({
        used_on: usedOn,
        system_type: systemType,
        responsible_member_id: responsibleMemberId,
        group_pay: groupPay,
        turn_heater_on: turnHeaterOn,
        target_temperature_f: turnHeaterOn === "On" ? targetTemperatureF : null,
        set_a_timer: timerEnabled,
        timer_start: timerEnabled ? timerStart : null,
        timer_stop: timerEnabled ? timerStop : null,
        start_at: startAtIso,
        note: note || null
      })
      .select("id")
      .single();

    if (error) {
      throw error;
    }

    if (groupPay && createdEntry?.id) {
      const groupRows = [...new Set(multiResponsibleMemberIds)].map((memberId) => ({
        heater_use_entry_id: createdEntry.id,
        account_member_id: memberId
      }));

      const { error: groupError } = await client
        .from("heater_use_group_members")
        .insert(groupRows);

      if (groupError) {
        throw groupError;
      }
    }

    if (createdEntry?.id) {
      heaterUseEntries = [
        {
          id: createdEntry.id,
          usedOn,
          systemType,
          event: null,
          responsibleMemberId,
          groupMemberIds: groupPay ? [...new Set(multiResponsibleMemberIds)] : [],
          groupPay,
          turnHeaterOn,
          targetTemperatureF: turnHeaterOn === "On" ? targetTemperatureF : null,
          setATimer: timerEnabled,
          timerStart: timerEnabled ? timerStart : null,
          timerStop: timerEnabled ? timerStop : null,
          startAt: startAtIso,
          endAt: null,
          paid: false,
          note: note || ""
        },
        ...heaterUseEntries.filter((entry) => entry.id !== createdEntry.id)
      ];
      render("heaterRecords");
    }

    if (turnHeaterOn === "On") {
      const smsRecipients = groupPay ? multiResponsibleMemberIds : [singleResponsibleMemberId];
      await triggerHeaterOnSequence(smsRecipients, {
        systemType,
        targetTemperatureF
      }).catch((sequenceError) => {
        console.warn("Heater on sequence failed.", sequenceError);
      });
    } else if (turnHeaterOn === "Off") {
      const smsRecipients = groupPay ? multiResponsibleMemberIds : [singleResponsibleMemberId];
      await triggerHeaterOffSequence(smsRecipients, {
        systemType,
        heaterUseEntryId: createdEntry?.id || null,
        timerTriggered: false
      }).catch((sequenceError) => {
        console.warn("Heater off sequence failed.", sequenceError);
      });
    }

    thermostatStatusFetchedAt = 0;
    await fetchThermostatStatus({ force: true }).catch((error) => {
      console.warn("Could not refresh thermostat status.", error);
    });
    await hydrateFromSupabase();
    clearThermostatActionFeedback();
    render("heaterRecords");
  } catch (error) {
    clearThermostatActionFeedback();
    if (appState.currentRoute === "heaterRecords") render("heaterRecords");
    showDetailActionMessage(error.message || "Could not save heater record.");
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "Save";
    }
  }
}

function bindRouteActions() {
  document.querySelectorAll("[data-route-target]").forEach((button) => {
    button.addEventListener("click", () => render(button.dataset.routeTarget));
  });

  document.querySelectorAll(".segmented-control").forEach((group) => {
    if (group.dataset.multiSelect === "true") {
      return;
    }

    group.querySelectorAll(".segment").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.classList.contains("is-disabled")) return;
        group.querySelectorAll(".segment").forEach((segment) => {
          segment.classList.toggle("is-selected", segment === button);
        });
        updateOpenGymWarning(button);
        updateHeaterGroupPayFields(button);
        updateHeaterTimerFields(button);
        updateThermostatSystemFields(button);
      });
    });
  });

  document.querySelectorAll(".segment.is-selected").forEach(updateOpenGymWarning);

  const memberSignInSave = document.querySelector(".member-sign-in-screen .save-action");
  memberSignInSave?.addEventListener("click", saveMemberSignIn);

  const guestSignInSave = document.querySelector(".guest-sign-in-screen .save-action");
  guestSignInSave?.addEventListener("click", saveGuestSignIn);

  const heaterUseSave = document.querySelector(".heater-use-screen .save-action");
  heaterUseSave?.addEventListener("click", saveHeaterUse);

  document.querySelectorAll("[data-gym-lights-mode-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const targetMode = button.dataset.gymLightsModeAction === "half" ? "half" : "full";
      button.disabled = true;
      button.textContent = "Working...";
      try {
        await setGymLightsMode(targetMode);
        render("currentlySignedIn");
      } catch (error) {
        showDetailActionMessage(error.message || "Could not change lights mode.");
      } finally {
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll("[data-sign-out-entry]").forEach((button) => {
    button.addEventListener("click", () => signOutTimesheetEntry(button.dataset.signOutEntry));
  });
}

function loginEmailValue() {
  return String(appLoginEmail?.value || "").trim().toLowerCase();
}

async function handlePasswordLogin() {
  const email = loginEmailValue();
  const password = String(appLoginPassword?.value || "");

  if (!email || !password) {
    setAuthMessage("Enter your email and password.", "error");
    return;
  }

  setAuthButtonBusy(appLoginButton, true, "Logging in...");
  setAuthMessage("Checking login...");

  try {
    const client = await createSupabaseClient();

    if (!client) {
      throw new Error("App data is not available.");
    }

    const { error } = await client.auth.signInWithPassword({ email, password });

    if (error) {
      throw error;
    }

    if (appLoginPassword) {
      appLoginPassword.value = "";
    }

    setAuthMessage("Loading RORC app...", "success");
    await hydrateFromSupabase();
  } catch (error) {
    setAuthMessage(error.message || "Could not log in.", "error");
  } finally {
    setAuthButtonBusy(appLoginButton, false);
  }
}

async function handleMagicLinkLogin() {
  const email = loginEmailValue();

  if (!email) {
    setAuthMessage("Enter your email first.", "error");
    return;
  }

  setAuthButtonBusy(appMagicLinkButton, true, "Sending...");
  setAuthMessage("Sending secure login link...");

  try {
    const client = await createSupabaseClient();

    if (!client) {
      throw new Error("App data is not available.");
    }

    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: appUrl(),
        shouldCreateUser: false
      }
    });

    if (error) {
      throw error;
    }

    setAuthMessage("Check your email for the RORC app login link.", "success");
  } catch (error) {
    setAuthMessage(error.message || "Could not send login link.", "error");
  } finally {
    setAuthButtonBusy(appMagicLinkButton, false);
  }
}

async function handlePasswordReset() {
  const email = loginEmailValue();

  if (!email) {
    setAuthMessage("Enter your email first.", "error");
    return;
  }

  setAuthButtonBusy(appResetPasswordButton, true, "Sending...");
  setAuthMessage("Sending password reset link...");

  try {
    const client = await createSupabaseClient();

    if (!client) {
      throw new Error("App data is not available.");
    }

    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: dashboardUrl()
    });

    if (error) {
      throw error;
    }

    setAuthMessage("Check your email for the password reset link.", "success");
  } catch (error) {
    setAuthMessage(error.message || "Could not send reset link.", "error");
  } finally {
    setAuthButtonBusy(appResetPasswordButton, false);
  }
}

async function handleLogout() {
  const client = await createSupabaseClient();

  if (client) {
    await client.auth.signOut({ scope: "local" });
  }

  currentAuthSession = null;
  appState.authMemberId = "";
  appState.currentUserEmail = "";
  appState.dataStatus = "loading";
  appState.dataError = "";
  clearLiveData();
  stopNotificationRealtime();
  stopTimesheetRealtime();
  stopAccountTypeRealtime();
  updateNavigationVisibility();
  showAuthGate("Signed out.", "success");
}

function bindAuthActions() {
  appLoginButton?.addEventListener("click", handlePasswordLogin);
  appMagicLinkButton?.addEventListener("click", handleMagicLinkLogin);
  appResetPasswordButton?.addEventListener("click", handlePasswordReset);
  appLogoutButton?.addEventListener("click", handleLogout);

  [appLoginEmail, appLoginPassword].forEach((input) => {
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        handlePasswordLogin();
      }
    });
  });
}

function render(routeName) {
  let resolvedRouteName = routeName;

  if (isKioskModeSession(appUserSession) && !kioskAllowedRoutes.has(resolvedRouteName)) {
    resolvedRouteName = "currentlySignedIn";
  }

  if (accountManagerOnlyRoutes.has(resolvedRouteName) && !isAccountManager(appUserSession)) {
    resolvedRouteName = "myAccount";
  }

  if (resolvedRouteName === "otherUsers" && !hasOtherUsersOnCurrentAccount()) {
    resolvedRouteName = "myAccount";
  }

  const route = routes[resolvedRouteName] || routes.currentlySignedIn;
  const template = document.getElementById(route.template);
  const resetScrollTop = () => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (view) {
      view.scrollTop = 0;
    }
  };

  if (!template || !view || !screenTitle || !appShell || !navControl) return;

  closeDrawer();
  appState.currentRoute = resolvedRouteName;

  const backRoute = Boolean(route.formRoute || route.detailRoute);
  const activeRouteName = resolvedRouteName === "accountDetails" ? appState.detailReturnRoute : resolvedRouteName;

  screenTitle.textContent = route.title;
  appShell.classList.toggle("is-form-route", Boolean(route.formRoute));
  appShell.classList.toggle("is-detail-route", Boolean(route.detailRoute));
  navControl.classList.toggle("is-back", backRoute);
  navControl.setAttribute("aria-label", backRoute ? "Go back" : "Open menu");

  resetScrollTop();

  view.innerHTML = "";
  view.appendChild(template.content.cloneNode(true));

  navItems.forEach((item) => {
    item.classList.toggle("is-active", item.dataset.route === activeRouteName);
  });

  drawerItems.forEach((item) => {
    item.classList.toggle("is-active", item.dataset.route === activeRouteName);
  });

  route.afterRender?.();
  resetScrollTop();
  populateMemberSignIn();
  populateGuestSignIn();
  bindMemberPickers();
  bindRouteActions();
}

navItems.forEach((item) => {
  item.addEventListener("click", () => render(item.dataset.route));
});

drawerItems.forEach((item) => {
  item.addEventListener("click", () => {
    const route = routes[item.dataset.route];

    if (route?.action) {
      route.action();
      return;
    }

    render(item.dataset.route);
    closeDrawer();
  });
});

drawerOverlay?.addEventListener("click", closeDrawer);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDrawer();
  }
});

navControl?.addEventListener("click", () => {
  if (appShell?.classList.contains("is-form-route")) {
    render(routes[appState.currentRoute]?.returnRoute || "currentlySignedIn");
    return;
  }

  if (appShell?.classList.contains("is-detail-route")) {
    render(appState.detailReturnRoute || "accountInfo");
    return;
  }

  if (appDrawer?.classList.contains("is-open")) {
    closeDrawer();
  } else {
    openDrawer();
  }
});

async function initApp() {
  bindAuthActions();

  try {
    await hydrateFromSupabase();
  } catch (error) {
    console.error("RORC app auth failed.", error);
    showAuthGate(error.message || "Could not check your RORC login.", "error");
  }
}

function registerAppServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    scheduleInstallRequestIfNeeded();
    return;
  }

  const reloadForAppUpdate = () => {
    if (appReloadingForUpdate) return;
    appReloadingForUpdate = true;
    window.location.reload();
  };

  navigator.serviceWorker.addEventListener("controllerchange", reloadForAppUpdate);
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "RORC_APP_UPDATED") {
      reloadForAppUpdate();
    }
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js", { scope: "./", updateViaCache: "none" })
      .then((registration) => {
        const checkForUpdate = () => {
          registration.update().catch((error) => {
            console.warn("RORC app update check failed.", error);
          });
        };

        checkForUpdate();
        window.setInterval(checkForUpdate, 5 * 60 * 1000);
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            checkForUpdate();
          }
        });
      })
      .catch((error) => {
        console.warn("RORC app service worker registration failed.", error);
      })
      .finally(scheduleInstallRequestIfNeeded);
  });
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;

  if (installFallbackTimer) {
    window.clearTimeout(installFallbackTimer);
    installFallbackTimer = null;
  }

  if (installRequestedFromUrl()) {
    showInstallSheet({
      title: "Download RORC App",
      message: "Install the RORC App to your home screen for faster member sign-in, guest sign-in, and heater records.",
      primaryLabel: "Install App",
      primaryAction: requestAppInstall
    });
  }
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  cleanInstallUrl();
});

initApp();
registerAppServiceWorker();
