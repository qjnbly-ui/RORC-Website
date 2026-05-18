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
let supabaseClient = null;
let currentAuthSession = null;
let deferredInstallPrompt = null;
let installFallbackTimer = null;

let accounts = [];
let accountMembers = [];
let globalMemberDirectory = [];
let timesheetEntries = [];
let heaterUseEntries = [];
let billingLineItems = [];
let notificationDispatchRecords = [];
let memberNotifications = [];
let notificationRealtimeChannel = null;
let notificationRealtimeRetryTimer = null;
let timesheetRealtimeChannel = null;
let timesheetRealtimeRetryTimer = null;
let timesheetSyncInFlight = false;
let heaterCountdownTimer = null;
const pendingHeaterAutoOffIds = new Set();
let notifiedIds = new Set();
let notificationUnreadCount = 0;
let accountTypePolicies = defaultAccountTypePolicies();

const statusOrder = [
  "Account Manager",
  "Kiosk Account",
  "Special Access Account",
  "Active Membership",
  "Open Gym Only",
  "RESTRICTED ACCOUNT"
];

const accountTypeOptions = [
  "Account Manager",
  "Kiosk Account",
  "Special Access Account",
  "Active Membership",
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


function canonicalAccountType(accountType) {
  const normalized = String(accountType || "").trim().toLowerCase();

  if (!normalized) return "Active Membership";
  if (normalized === "account manager") return "Account Manager";
  if (normalized === "kiosk account") return "Kiosk Account";
  if (normalized === "active membership") return "Active Membership";
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
  dataStatus: "loading",
  dataError: "",
  authMemberId: "",
  currentUserEmail: ""
};

const accountManagerOnlyRoutes = new Set([
  "accountInfo",
  "gymProjects",
  "advertisementBanners",
  "message",
  "notificationsEmail",
  "messageCompose",
  "contracts"
]);

const kioskAllowedRoutes = new Set([
  "memberSignIn",
  "guestSignIn",
  "currentlySignedIn",
  "heaterRecords",
  "heaterForm",
  "notifications",
  "feedback",
  "calendar"
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
    title: "Account & Info",
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
  messageCompose: {
    title: "Message Data Form",
    template: "feedbackTemplate",
    formRoute: true,
    returnRoute: "notificationsEmail",
    afterRender: renderMessageComposerPage
  },
  contracts: {
    title: "Contracts",
    template: "placeholderTemplate"
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

function isAccountManager(memberOrSession) {
  return canonicalAccountType(memberOrSession?.accountType) === "Account Manager";
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

function renderSharePage() {
  const content = document.getElementById("shareContent");
  if (!content) return;

  const inviteAllowed = canInviteAccountUsers();
  const inviteCopy = inviteAllowed
    ? "Account invites will connect the new user to your shared account number. This needs backend account-linking before it is enabled."
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
          <p class="eyebrow">Coming Soon</p>
          <h3>Invite User To My Account</h3>
          <p>${escapeHtml(inviteCopy)}</p>
        </div>
        <div class="share-invite-form" aria-disabled="true">
          <input type="email" placeholder="Email address" disabled />
          <button type="button" disabled>${inviteAllowed ? "Invite by Email" : "Locked"}</button>
        </div>
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

function renderAutomationSettingsPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  root.innerHTML = `
    <section class="feedback-shell">
      <header class="feedback-hero">
        <p class="eyebrow">Admin</p>
        <h2>Bot Settings</h2>
        <p>Control webhooks, SMS, and toggles for gym and heater automations.</p>
      </header>

      <form id="automationSettingsForm" class="feedback-form" autocomplete="off">
        <label class="automation-toggle">
          <input id="gymLightsOnEnabled" type="checkbox" />
          <span>Gym Lights On Enabled</span>
        </label>
        <label>
          <span>Gym Lights On SMS To</span>
          <input id="gymLightsOnSmsTo" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
        </label>

        <label class="automation-toggle">
          <input id="gymLightsOffEnabled" type="checkbox" />
          <span>Gym Lights Off Enabled</span>
        </label>
        <label>
          <span>Gym Lights Off SMS To</span>
          <input id="gymLightsOffSmsTo" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
        </label>

        <label class="automation-toggle">
          <input id="heaterOnEnabled" type="checkbox" />
          <span>Heater On Automation Enabled</span>
        </label>
        <label class="automation-toggle">
          <input id="heaterOffEnabled" type="checkbox" />
          <span>Heater Off Automation Enabled</span>
        </label>

        <div class="automation-advanced">
          <button id="toggleAutomationAdvanced" class="auth-secondary" type="button">Edit Advanced URLs</button>
          <div id="automationAdvancedFields" hidden>
            <label>
              <span>Gym Lights On Step 1 URL</span>
              <input id="gymLightsOnStep1Url" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" />
            </label>
            <label>
              <span>Gym Lights On Step 2 URL</span>
              <input id="gymLightsOnStep2Url" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" />
            </label>
            <label>
              <span>Gym Lights Off Step 1 URL</span>
              <input id="gymLightsOffStep1Url" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" />
            </label>
            <label>
              <span>Gym Lights Off Step 2 URL</span>
              <input id="gymLightsOffStep2Url" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" />
            </label>
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
  const orderedTypes = ["Account Manager", "Kiosk Account", "Special Access Account", "Active Membership", "Open Gym Only", "RESTRICTED ACCOUNT"];
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
            <label>
              <span>Allowed days (0=Sun ... 6=Sat)</span>
              <input id="policy_${key}_days" type="text" placeholder="0,1,2,3,4,5,6" autocomplete="off" />
            </label>
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

function renderNotificationsPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  const records = [...memberNotifications]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 100);

  root.innerHTML = `
    <section class="live-record-page">
      ${records.length ? `
      <div class="detail-card">
        <ol class="record-list heater-record-list">
          ${records.map((record) => `
            <li data-notification-item="${escapeAttribute(record.id)}">
              <strong class="heater-record-event">${escapeHtml(record.title)}</strong>
              <span class="heater-record-meta">${escapeHtml(record.channelsLabel)} · ${escapeHtml(record.recipientsLabel)} · ${formatShortDateTime(record.createdAt)}</span>
              <button class="heater-state-action is-paid" type="button" disabled>${escapeHtml(record.statusLabel)}</button>
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
      <button class="heater-fab message-fab" type="button" aria-label="Create new notification">
        <span class="heater-fab-label">New</span>
        <span class="heater-fab-icon" aria-hidden="true">+</span>
      </button>
    </section>
  `;

  document.querySelector(".message-fab")?.addEventListener("click", () => {
    render("messageCompose");
  });

  bindNotificationOpenActions();
}

function renderUserNotificationsPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  const records = [...memberNotifications]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 100);

  root.innerHTML = `
    <section class="live-record-page">
      ${records.length ? `
      <div class="detail-card">
        <ol class="record-list heater-record-list">
          ${records.map((record) => `
            <li data-notification-item="${escapeAttribute(record.id)}">
              <strong class="heater-record-event">${escapeHtml(record.title)}</strong>
              <span class="heater-record-meta">${escapeHtml(record.channelsLabel)} · ${escapeHtml(record.recipientsLabel)} · ${formatShortDateTime(record.createdAt)}</span>
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
  bindNotificationOpenActions();
}

function bindNotificationOpenActions() {
  document.querySelectorAll("[data-notification-item]").forEach((row) => {
    row.addEventListener("click", () => {
      const notificationId = String(row.dataset.notificationItem || "").trim();
      if (!notificationId) return;
      const notification = memberNotifications.find((row) => row.id === notificationId);
      if (!notification) return;

      const title = notification.title || "Notification";
      const details = [
        formatShortDateTime(notification.createdAt),
        notification.channelsLabel || "",
        notification.recipientsLabel || "",
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

async function triggerHeaterOnSequence(memberIds) {
  const token = currentAuthSession?.access_token || "";
  if (!token || !Array.isArray(memberIds) || memberIds.length === 0) return;

  const response = await fetch("/api/heater-on-sequence", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      memberIds: [...new Set(memberIds)]
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Heater-on sequence failed.");
  }
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
        includeText,
        includeEmail,
        includeInApp,
        selectedCount: memberIds.length,
        sentTextCount: response.sentTextCount || 0,
        sentEmailCount: response.sentEmailCount || 0,
        sentInAppCount: response.sentInAppCount || 0
      });
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
  includeText,
  includeEmail,
  includeInApp,
  selectedCount,
  sentTextCount,
  sentEmailCount,
  sentInAppCount
}) {
  const channels = [];
  if (includeText) channels.push("Text");
  if (includeEmail) channels.push("Email");
  if (includeInApp) channels.push("In-App");

  const record = {
    id: `msg-${Date.now()}`,
    title: String(title || "").trim() || "Message",
    channelsLabel: channels.join(" + ") || "Unspecified",
    recipientsLabel: `${selectedCount || 0} members`,
    statusLabel: `SMS ${sentTextCount || 0} · Email ${sentEmailCount || 0} · In-App ${sentInAppCount || 0}`,
    createdAt: new Date().toISOString()
  };
  notificationDispatchRecords.unshift(record);
  memberNotifications.unshift(record);
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
  setValue("gymLightsOnStep1Url", settings.gym_lights_on?.step1_url);
  setValue("gymLightsOnStep2Url", settings.gym_lights_on?.step2_url);
  setValue("gymLightsOnSmsTo", settings.gym_lights_on?.sms_to);

  setChecked("gymLightsOffEnabled", settings.gym_lights_off?.enabled);
  setValue("gymLightsOffStep1Url", settings.gym_lights_off?.step1_url);
  setValue("gymLightsOffStep2Url", settings.gym_lights_off?.step2_url);
  setValue("gymLightsOffSmsTo", settings.gym_lights_off?.sms_to);

  setChecked("heaterOnEnabled", settings.heater_on?.enabled);
  setChecked("heaterOffEnabled", settings.heater_off?.enabled);

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
  const orderedTypes = ["Account Manager", "Kiosk Account", "Special Access Account", "Active Membership", "Open Gym Only", "RESTRICTED ACCOUNT"];

  orderedTypes.forEach((type) => {
    const policy = policies[type] || defaults[type];
    const key = policyFieldKey(type);
    const canSignIn = document.getElementById(`policy_${key}_can_sign_in`);
    const bypass = document.getElementById(`policy_${key}_bypass`);
    const days = document.getElementById(`policy_${key}_days`);
    const start = document.getElementById(`policy_${key}_start`);
    const end = document.getElementById(`policy_${key}_end`);
    if (canSignIn) canSignIn.checked = Boolean(policy?.canSignIn);
    if (bypass) bypass.checked = Boolean(policy?.bypassTimeWindows);
    if (days) days.value = (policy?.allowedDays || []).join(",");
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
      step1_url: getValue("gymLightsOnStep1Url"),
      step2_url: getValue("gymLightsOnStep2Url"),
      sms_to: getValue("gymLightsOnSmsTo")
    },
    gym_lights_off: {
      enabled: isChecked("gymLightsOffEnabled"),
      step1_url: getValue("gymLightsOffStep1Url"),
      step2_url: getValue("gymLightsOffStep2Url"),
      sms_to: getValue("gymLightsOffSmsTo")
    },
    heater_on: {
      enabled: isChecked("heaterOnEnabled")
    },
    heater_off: {
      enabled: isChecked("heaterOffEnabled")
    },
    account_type_permissions: collectAccountTypePoliciesFromForm()
  };
}

function collectAccountTypePoliciesFromForm() {
  const orderedTypes = ["Account Manager", "Kiosk Account", "Special Access Account", "Active Membership", "Open Gym Only", "RESTRICTED ACCOUNT"];
  const policies = {};

  orderedTypes.forEach((type) => {
    const key = policyFieldKey(type);
    const canSignIn = Boolean(document.getElementById(`policy_${key}_can_sign_in`)?.checked);
    const bypass = Boolean(document.getElementById(`policy_${key}_bypass`)?.checked);
    const daysRaw = String(document.getElementById(`policy_${key}_days`)?.value || "");
    const days = daysRaw
      .split(",")
      .map((value) => Number(String(value).trim()))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
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

async function bindAutomationSettingsActions() {
  const form = document.getElementById("automationSettingsForm");
  const saveButton = document.getElementById("automationSettingsSave");
  if (!form || !saveButton) return;
  const advancedToggle = document.getElementById("toggleAutomationAdvanced");
  const advancedFields = document.getElementById("automationAdvancedFields");

  try {
    automationResult("Loading settings...");
    const settings = await loadAutomationSettings();
    applyAutomationSettingsToForm(settings);
    automationResult("Loaded.", "success");
  } catch (error) {
    automationResult(error.message || "Could not load settings.", "error");
  }

  advancedToggle?.addEventListener("click", () => {
    if (!advancedFields) return;
    const nextHidden = !advancedFields.hidden;
    advancedFields.hidden = nextHidden;
    advancedToggle.textContent = nextHidden ? "Edit Advanced URLs" : "Hide Advanced URLs";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
    automationResult("Saving...");

    try {
      const settings = collectAutomationSettingsFromForm();
      await saveAutomationSettings(settings);
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
  memberNotifications = [];
  notifiedIds = new Set();
  accountTypePolicies = defaultAccountTypePolicies();
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
      item.hidden = !["feedback", "calendar", "notifications"].includes(routeName);
    });
  }
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
}

function updateNotificationBadge() {
  const badge = document.getElementById("drawerNotificationsBadge");
  if (!badge) return;

  const hasUnread = notificationUnreadCount > 0;
  badge.hidden = !hasUnread;
  badge.textContent = hasUnread ? `New ${notificationUnreadCount}` : "New";
}

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = Number(statusCode) || 500;
  return error;
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
      ? Object.entries(row.channels || {}).filter(([, enabled]) => Boolean(enabled)).map(([k]) => (
        k === "inApp" ? "In-App" : k === "browser" ? "Browser" : k === "text" ? "Text" : k === "email" ? "Email" : k
      )).join(" + ") || "In-App"
      : "In-App",
    recipientsLabel: row.recipient_member_id === appState.authMemberId ? "To you" : "Shared account",
    statusLabel: row.recipient_member_id === appState.authMemberId
      ? (row.read_at ? "Read" : "Unread")
      : "Delivered",
    createdAt: row.created_at,
    readAt: row.read_at,
    rawChannels: row.channels || {},
    recipientMemberId: row.recipient_member_id
  }));
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

function scheduleTimesheetRealtimeReconnect() {
  if (timesheetRealtimeRetryTimer) return;
  timesheetRealtimeRetryTimer = window.setTimeout(() => {
    timesheetRealtimeRetryTimer = null;
    void startTimesheetRealtime();
  }, 2500);
}

async function startTimesheetRealtime() {
  stopTimesheetRealtime();

  const client = await createSupabaseClient();
  if (!client) return;

  timesheetRealtimeChannel = client
    .channel("timesheet-entries-live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "timesheet_entries" },
      async () => {
        await syncTimesheetEntries({ rerender: appState.currentRoute === "currentlySignedIn" });
      }
    )
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await syncTimesheetEntries({ rerender: appState.currentRoute === "currentlySignedIn" });
        return;
      }

      if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
        scheduleTimesheetRealtimeReconnect();
      }
    });

}

async function syncTimesheetEntries({ rerender = false } = {}) {
  if (timesheetSyncInFlight) return;

  const client = await createSupabaseClient();
  if (!client) return;

  timesheetSyncInFlight = true;
  try {
    const timesheetResult = await client
      .from("timesheet_entries")
      .select("*")
      .order("signed_in_at", { ascending: false })
      .limit(1000);

    if (timesheetResult.error) {
      throw timesheetResult.error;
    }

    const nextEntries = (timesheetResult.data || []).map((row) => ({
      id: row.id,
      memberId: row.member_id,
      memberOrGuest: row.member_or_guest,
      guestName: row.guest_name || "",
      memberEnteredWithId: row.member_entered_with_id || "",
      signedInAt: row.signed_in_at,
      signedOutAt: row.signed_out_at || "",
      accountTypeAtSignIn: row.account_type_at_sign_in || "",
      locationLabel: row.location_label || ""
    }));

    timesheetEntries = nextEntries;
    refreshSessions(appState.authMemberId);
    if (rerender && appState.currentRoute === "currentlySignedIn") {
      renderCurrentlySignedIn();
      bindRouteActions();
    }
  } finally {
    timesheetSyncInFlight = false;
  }
}

function scheduleNotificationRealtimeReconnect() {
  if (notificationRealtimeRetryTimer) return;
  notificationRealtimeRetryTimer = window.setTimeout(() => {
    notificationRealtimeRetryTimer = null;
    void startNotificationRealtime();
  }, 2500);
}

async function refreshNotificationsForCurrentRoute(announceNew = true) {
  await refreshMemberNotifications({ announceNew });
  if (appState.currentRoute === "notificationsEmail" || appState.currentRoute === "notifications") {
    render(appState.currentRoute);
  }
}

async function startNotificationRealtime() {
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

    const profiles = profilesResult.data || [];
    const currentProfile = findProfileForSession(currentAuthSession, profiles);

    if (!profiles.length) {
      throw new Error("No member profiles were returned for this login.");
    }

    if (!currentProfile) {
      throw new Error("This signed-in user is not linked to a RORC member profile.");
    }

    const [
      timesheetResult,
      heaterResult,
      heaterGroupResult,
      billingResult,
      permissionsResult
    ] = await Promise.all([
      client
        .from("timesheet_entries")
        .select("*")
        .order("signed_in_at", { ascending: false })
        .limit(1000),
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
    try {
      await startNotificationRealtime();
      await startTimesheetRealtime();
    } catch (notificationError) {
      console.warn("Could not load notifications.", notificationError);
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
    allowHeaterUse: accountTypeAllowsHeater(canonicalAccountType(row.account_type)),
    isBillingOwner: Boolean(row.is_billing_owner)
  }));
}

function applySupabaseData({
  profiles,
  timesheetRows,
  heaterRows,
  heaterGroupRows,
  billingRows,
  permissionsRows
}) {
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
    allowHeaterUse: accountTypeAllowsHeater(canonicalAccountType(row.account_type)),
    isBillingOwner: Boolean(row.is_billing_owner)
  }));

  timesheetEntries = timesheetRows.map((row) => ({
    id: row.id,
    memberOrGuest: row.member_or_guest,
    memberId: row.member_id,
    guestName: row.guest_name || "",
    dayPassOrOpenGym: row.day_pass_or_open_gym || "",
    memberEnteredWithId: row.member_entered_with_id,
    liabilityAccepted: Boolean(row.liability_accepted),
    signedInAt: row.signed_in_at,
    signedOutAt: row.signed_out_at
  }));

  const heaterGroupMap = heaterGroupRows.reduce((map, row) => {
    const current = map.get(row.heater_use_entry_id) || [];
    current.push(row.account_member_id);
    map.set(row.heater_use_entry_id, current);
    return map;
  }, new Map());

  heaterUseEntries = heaterRows.map((row) => ({
    id: row.id,
    usedOn: row.used_on,
    event: row.event,
    responsibleMemberId: row.responsible_member_id,
    groupMemberIds: heaterGroupMap.get(row.id) || [],
    groupPay: Boolean(row.group_pay),
    turnHeaterOn: row.turn_heater_on || "On",
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

  accountTypePolicies = normalizeAccountTypePolicies(permissionsRows);
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

function accountTypeAllowsHeater(accountType) {
  return ["Account Manager", "Kiosk Account", "Active Membership", "Special Access Account"].includes(canonicalAccountType(accountType));
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
  const visibleMembers = visibleMembersForSession(session);

  return visibleMembers.filter((member) => (
    member.accountType === "Account Manager"
    || member.accountType === "Active Membership"
    || member.allowGuestEntry
  ));
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
  if (normalizedType === "RESTRICTED ACCOUNT") return "red";
  if (normalizedType === "Special Access Account") return "purple";
  return "green";
}

function heaterDisplayState(entry) {
  return heaterRecordStatus(entry).label;
}

function heaterRecordStatus(entry) {
  const isCurrentlyOn = !entry?.endAt && (entry?.turnHeaterOn || "On") === "On";

  return {
    key: isCurrentlyOn ? "currently-on" : "complete",
    label: isCurrentlyOn ? "Currently On" : "Complete"
  };
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
  const totalMin = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return hours > 0 ? `Timer ${hours}h ${mins}m left` : `Timer ${mins}m left`;
}

function configuredTimerMinutes(entry) {
  const target = heaterTimerTarget(entry);
  const start = entry?.startAt ? new Date(entry.startAt) : null;
  if (!target || !start || Number.isNaN(target.getTime()) || Number.isNaN(start.getTime())) return null;
  const minutes = Math.round((target.getTime() - start.getTime()) / 60000);
  return minutes > 0 ? minutes : null;
}

function sortMembers(a, b) {
  const pickerOrder = ["Account Manager", "Kiosk Account", "Special Access Account", "Active Membership", "Open Gym Only", "RESTRICTED ACCOUNT"];
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

function accessCopy(accountType) {
  const normalizedType = canonicalAccountType(accountType);
  if (normalizedType === "Open Gym Only") return "Open Gym access Tuesday and Thursday nights from 6pm - 8pm.";
  if (normalizedType === "Account Manager") return "Account Manager access with full administrative permissions.";
  if (normalizedType === "Kiosk Account") return "Kiosk account access for member sign-in, guest sign-in, currently signed in, heater records, feedback, and calendar.";
  if (normalizedType === "Special Access Account") return "Custom contract access for approved organizations and special-use accounts.";
  if (normalizedType === "RESTRICTED ACCOUNT") return "Access is blocked until the account is restored.";
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
      <div class="status-panel">
        <div class="member-card-list">
          ${openEntries.map(renderSignedInCard).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderCurrentlySignedInRoute() {
  renderCurrentlySignedIn();
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
  const client = await createSupabaseClient();

  if (!client) {
    showDetailActionMessage("App data is not available.");
    return;
  }

  const button = document.querySelector(`[data-sign-out-entry="${CSS.escape(entryId)}"]`);
  const entry = timesheetEntries.find((item) => item.id === entryId);
  const wasOneSignedIn = openTimesheetCount() === 1;
  if (button) {
    button.disabled = true;
    button.textContent = "Signing Out...";
  }

  try {
    const { error } = await client
      .from("timesheet_entries")
      .update({ signed_out_at: new Date().toISOString() })
      .eq("id", entryId)
      .is("signed_out_at", null);

    if (error) {
      throw error;
    }

    if (entry?.memberOrGuest === "Member" && entry.memberId) {
      const guestSignOutResult = await client
        .from("timesheet_entries")
        .update({ signed_out_at: new Date().toISOString() })
        .eq("member_or_guest", "Guest")
        .eq("member_entered_with_id", entry.memberId)
        .is("signed_out_at", null);

      if (guestSignOutResult.error) {
        throw guestSignOutResult.error;
      }
    }

    await hydrateFromSupabase();
    if (wasOneSignedIn && openTimesheetCount() === 0) {
      const memberName = entry?.memberId ? (findMember(entry.memberId)?.memberName || "Unknown") : "Unknown";
      const visitDurationMinutes = durationMinutes(entry?.signedInAt, new Date().toISOString()) || 0;
      triggerGymLightsOffSequence(memberName, visitDurationMinutes).catch((sequenceError) => {
        console.warn("Gym lights off sequence failed.", sequenceError);
      });
    }
    render("currentlySignedIn");
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

  const records = [...heaterUseEntries]
    .sort((a, b) => new Date(b.startAt || b.usedOn) - new Date(a.startAt || a.usedOn))
    .slice(0, 50);
  const activeTimerEntry = records.find((entry) => !entry.endAt && entry.setATimer && entry.timerStop);
  const activeTimerCountdown = activeTimerEntry ? heaterCountdownText(activeTimerEntry) : "";
  const timerStatusNote = activeTimerEntry
    ? `
      <p class="data-source-note heater-timer-note">
        <span class="heater-timer-note-desktop">Timer is active. It can be turned off early.</span>
        <span class="heater-timer-note-mobile">${escapeHtml(activeTimerCountdown || "Timer is active")} · Can be turned off early.</span>
      </p>
    `
    : "";

  if (records.length === 0) {
    root.innerHTML = `
      <section class="empty-state">
        <p>No items</p>
      </section>
    `;
    bindHeaterRecordsActions();
    return;
  }

  root.innerHTML = `
    <section class="live-record-page">
      <p class="data-source-note">Live data</p>
      ${timerStatusNote}
      <div class="detail-card">
        <ol class="record-list heater-record-list">
          ${records.map((entry) => {
            const member = findMember(entry.responsibleMemberId);
            const heaterState = heaterRecordStatus(entry);
            const timerCountdown = heaterCountdownText(entry);
            return `
              <li>
                <strong class="heater-record-event">${escapeHtml(entry.event || "Heater Use")}</strong>
                <span class="heater-record-meta">${formatShortDate(entry.usedOn)} · ${escapeHtml(member?.memberName || "No responsible member")}${timerCountdown ? ` <span class="heater-row-timer">· ${escapeHtml(timerCountdown)}</span>` : ""}</span>
                <button class="heater-state-action is-${escapeHtml(heaterState.key)}" data-heater-state="${escapeHtml(heaterState.key)}" type="button">${escapeHtml(heaterState.label)}</button>
              </li>
            `;
          }).join("")}
        </ol>
      </div>
    </section>
  `;

  const hasOpenHeater = records.some((entry) => heaterRecordStatus(entry).key === "currently-on");
  const fab = document.querySelector(".heater-fab");
  const fabLabel = fab?.querySelector(".heater-fab-label");
  const confirmMessage = document.querySelector("#heaterConfirm .confirm-dialog p");
  const confirmAccept = document.querySelector("[data-heater-confirm-accept]");

  if (fab && fabLabel && confirmMessage && confirmAccept) {
    fabLabel.textContent = hasOpenHeater ? "Heater Off" : "Heater On";
    fab.setAttribute("aria-label", hasOpenHeater ? "Open heater off confirm" : "Open heater use form");
    confirmAccept.textContent = hasOpenHeater ? "HEATER OFF" : "HEATER ON";
    confirmMessage.innerHTML = hasOpenHeater
      ? "Turn Heater Off<br /><span>(Ends current heater billing record)</span>"
      : "Open Heater Use Form<br /><span>(Heater costs $13 per hour)</span>";
  }

  bindHeaterRecordsActions();

  const expiredTimers = records.filter((entry) => {
    if (entry.endAt || !entry.setATimer || (entry.turnHeaterOn || "On") !== "On") return false;
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

  const hasActiveTimer = records.some((entry) => !entry.endAt && entry.setATimer && entry.timerStop);
  if (hasActiveTimer && appState.currentRoute === "heaterRecords") {
    heaterCountdownTimer = window.setTimeout(() => {
      if (appState.currentRoute === "heaterRecords") {
        render("heaterRecords");
      }
    }, 30000);
  }
}

function activeHeaterEntry() {
  return [...heaterUseEntries]
    .filter((entry) => !entry.endAt && (entry.turnHeaterOn || "On") === "On")
    .sort((a, b) => new Date(b.startAt || b.usedOn) - new Date(a.startAt || a.usedOn))[0] || null;
}

async function turnHeaterOffActiveEntry() {
  const activeEntry = activeHeaterEntry();

  if (!activeEntry) {
    showDetailActionMessage("No active heater entry found.");
    return;
  }

  const client = await createSupabaseClient();

  if (!client) {
    showDetailActionMessage("App data is not available.");
    return;
  }

  const { error } = await client
    .from("heater_use_entries")
    .update({
      end_at: new Date().toISOString(),
      turn_heater_on: "Off"
    })
    .eq("id", activeEntry.id)
    .is("end_at", null);

  if (error) {
    throw error;
  }

  const offRecipients = activeEntry.groupPay
    ? activeEntry.groupMemberIds
    : [activeEntry.responsibleMemberId];

  triggerHeaterOffSequence(offRecipients, {
    heaterUseEntryId: activeEntry.id,
    timerTriggered: false
  }).catch((sequenceError) => {
    console.warn("Heater off sequence failed.", sequenceError);
  });

  await hydrateFromSupabase();
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
    triggerHeaterOffSequence(offRecipients, {
      heaterUseEntryId: entry.id,
      timerTriggered,
      timerMinutes: timerTriggered ? configuredTimerMinutes(entry) : null
    }).catch((sequenceError) => {
      console.warn("Heater off sequence failed.", sequenceError);
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

function renderAccountInfo() {
  const root = document.getElementById("accountInfoContent");

  if (!root) return;

  if (!isAccountManager(appUserSession)) {
    root.innerHTML = `
      <div class="restricted-card">
        <p class="eyebrow">Account Manager Only</p>
        <h2>Account &amp; Info is restricted.</h2>
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
        <p class="eyebrow">Account Manager View</p>
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
  const canView = isAccountManager(appUserSession)
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
          <button class="edit-chip" data-detail-action="edit" data-member-id="${escapeAttribute(member.id)}" type="button">Edit</button>
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
  return `
    <div class="detail-card">
      <h3>Member</h3>
      ${renderDefinitionGrid([
        ["Member Name", member.memberName],
        ["Account Number", memberAccountNumber],
        ["Account Type", member.accountType],
        ["Phone Number", member.phoneNumber || "Not set"],
        ["Email Address", member.emailAddress || "Not set"],
        ["Billing Owner", member.isBillingOwner ? "Yes" : "No"],
        ["Guest Entry", member.allowGuestEntry ? "Allowed" : "Not allowed"],
        ["Heater Use", member.allowHeaterUse ? "Allowed" : "Not allowed"]
      ])}
    </div>
    <div class="detail-card">
      <h3>Shared Account</h3>
      ${renderDefinitionGrid([
        ["Membership Details", account?.membershipDetails || accessCopy(member.accountType)],
        ["Notes On Account", account?.notesOnAccount || "None"],
        ["Billing Status", account?.billingStatus || "None"],
        ["Stripe Status", account?.stripeStatus || "None"],
        ["Current Period End", account?.currentPeriodEnd ? formatShortDate(account.currentPeriodEnd) : "Not set"],
        ["Heater Billing ID", account?.billingIdHeater || "Not set"],
        ["Heater PIN", account?.heaterPin ? "Set (shared on account)" : "Not set"]
      ])}
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
          <li>
            <div>
              <strong>${escapeHtml(item.reason)}</strong>
              <span>${formatShortDateTime(item.createdAt)} · ${item.postedToStripeAt ? "Posted to Stripe" : "Pending monthly billing"}</span>
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
          <li>
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
          <li>
            <div>
              <strong>${escapeHtml(item.guestName)}</strong>
              <span>${formatShortDateTime(item.signedInAt)} · ${escapeHtml(item.dayPassOrOpenGym || "Day Pass")} · Liability ${item.liabilityAccepted ? "accepted" : "not accepted"}</span>
            </div>
            <b>${item.dayPassOrOpenGym === "Open Gym" ? "Free" : "$0.25"}</b>
          </li>
        `).join("")}
      </ol>
    </div>
  `;
}

function renderHeaterPanel(items) {
  if (items.length === 0) return renderPanelEmpty("No heater use records for this member.");

  return `
    <div class="detail-card">
      <h3>Heater Use</h3>
      <ol class="record-list">
        ${items.map((item) => `
          <li>
            <div>
              <strong>${escapeHtml(item.event || "Member Use")}</strong>
              <span>${formatShortDate(item.usedOn)} · ${formatDuration(item.startAt, item.endAt)}</span>
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
  return Boolean(isAccountManager(appUserSession) || member?.id === appUserSession.memberId);
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

async function updateMemberContact(member, updates) {
  const client = await createSupabaseClient();

  if (!client) {
    throw new Error("App data is not available.");
  }

  const dbUpdates = {
    phone_number: updates.phoneNumber,
    email_address: updates.emailAddress
  };

  if (isAccountManager(appUserSession)) {
    dbUpdates.member_name = updates.memberName;
    dbUpdates.account_type = updates.accountType || member.accountType;
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

  if (isAccountManager(appUserSession)) {
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

  if (isAccountManager(appUserSession) && updates.accountNumber) {
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

  if (isAccountManager(appUserSession) && Object.prototype.hasOwnProperty.call(updates, "stripeCustomerId")) {
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

  syncLocalMember(member.id, {
    ...updates,
    accountType: updates.accountType || member.accountType,
    allowHeaterUse: accountTypeAllowsHeater(updates.accountType || member.accountType)
  });

  if (isAccountManager(appUserSession)) {
    accountMembers.forEach((accountMember) => {
      if (accountMember.accountId === member.accountId) {
        syncLocalMember(accountMember.id, {
          accountType: updates.accountType || member.accountType,
          allowHeaterUse: accountTypeAllowsHeater(updates.accountType || member.accountType)
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

async function deleteMemberRecord(member) {
  if (!isAccountManager(appUserSession)) {
    throw new Error("Only account managers can delete members.");
  }

  if (!member?.id) {
    throw new Error("Member not found.");
  }

  if (member.id === appUserSession.memberId) {
    throw new Error("You cannot delete your own signed-in member record.");
  }

  const client = await createSupabaseClient();

  if (!client) {
    throw new Error("App data is not available.");
  }

  const { error } = await client
    .from("account_members")
    .delete()
    .eq("id", member.id);

  if (error) {
    throw error;
  }

  removeLocalMember(member.id);
  appState.selectedMemberId = null;
  refreshSessions(appState.authMemberId);
  updateDrawerIdentity();
}

function openMemberEditDialog(member) {
  if (!canEditMember(member)) {
    showDetailActionMessage("You can view this account, but you cannot edit it.");
    return;
  }

  const canEditName = isAccountManager(appUserSession);
  const canDeleteMember = isAccountManager(appUserSession) && member.id !== appUserSession.memberId;
  const account = accountForMember(member);
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
        <div class="pin-input-row">
          <input id="editAccountHeaterPin" type="password" value="${escapeAttribute(account?.heaterPin || "")}" inputmode="numeric" pattern="[0-9]*" maxlength="4" minlength="4" autocomplete="off" />
          <button id="toggleAccountHeaterPinVisibility" class="auth-secondary" type="button">Unveil</button>
        </div>
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
        <span>Stripe Customer ID</span>
        <input id="editStripeCustomerId" type="text" value="${escapeAttribute(account?.stripeCustomerId || "")}" placeholder="cus_..." autocapitalize="off" autocomplete="off" spellcheck="false" />
      </label>
      ` : ""}

      <p id="editMemberResult" class="member-edit-result"></p>

      <footer>
        ${canDeleteMember ? '<button class="member-edit-delete" type="button">Delete</button>' : ""}
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
  const deleteButton = overlay.querySelector(".member-edit-delete");
  overlay.querySelector("#toggleAccountHeaterPinVisibility")?.addEventListener("click", () => {
    const pinInput = overlay.querySelector("#editAccountHeaterPin");
    const toggle = overlay.querySelector("#toggleAccountHeaterPinVisibility");
    if (!pinInput || !toggle) return;
    const reveal = pinInput.type === "password";
    pinInput.type = reveal ? "text" : "password";
    toggle.textContent = reveal ? "Hide" : "Unveil";
  });
  const openDeleteConfirmDialog = () => new Promise((resolve) => {
    const confirmOverlay = document.createElement("div");
    confirmOverlay.className = "member-delete-confirm-overlay";
    confirmOverlay.innerHTML = `
      <section class="member-delete-confirm-dialog" role="dialog" aria-modal="true" aria-label="Confirm member delete">
        <h3>Delete ${escapeHtml(member.memberName)}?</h3>
        <p>This permanently removes this member record.</p>
        <footer>
          <button class="member-delete-confirm-cancel" type="button">Cancel</button>
          <button class="member-delete-confirm-accept" type="button">Delete</button>
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
  deleteButton?.addEventListener("click", async () => {
    if (!canDeleteMember) {
      setResult("Only account managers can delete members.", "error");
      return;
    }

    const confirmed = await openDeleteConfirmDialog();
    if (!confirmed) return;

    deleteButton.disabled = true;
    saveButton.disabled = true;
    setResult("Deleting...");

    try {
      await deleteMemberRecord(member);
      close();
      render(appState.detailReturnRoute || "accountInfo");
    } catch (error) {
      setResult(error.message || "Could not delete member.", "error");
      deleteButton.disabled = false;
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

  if (button.dataset.detailAction === "edit") {
    openMemberEditDialog(member);
  }
}

function bindAccountDetailActions() {
  document.querySelectorAll("[data-detail-action]").forEach((button) => {
    button.addEventListener("click", () => handleDetailQuickAction(button));
  });

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

function bindHeaterRecordsActions() {
  const confirm = document.getElementById("heaterConfirm");
  const openButton = document.querySelector("[data-open-heater-confirm]");
  const closeButton = document.querySelector("[data-heater-confirm-close]");
  const acceptButton = document.querySelector("[data-heater-confirm-accept]");

  if (!confirm || !openButton || !closeButton || !acceptButton) return;

  openButton.addEventListener("click", () => {
    confirm.hidden = false;
  });

  closeButton.addEventListener("click", () => {
    confirm.hidden = true;
  });

  acceptButton.addEventListener("click", () => {
    confirm.hidden = true;
    const isHeaterOffAction = String(openButton.querySelector(".heater-fab-label")?.textContent || "").trim() === "Heater Off";

    if (isHeaterOffAction) {
      turnHeaterOffActiveEntry().catch((error) => {
        showDetailActionMessage(error.message || "Could not turn heater off.");
      });
      return;
    }

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

  const turnHeaterSegments = document.querySelectorAll('.heater-use-screen [aria-label="Turn heater on"] .segment');
  turnHeaterSegments.forEach((segment, index) => {
    segment.classList.toggle("is-selected", index === 0);
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

  if (!input || !dateTimeIn) return;

  dateTimeIn.value = formatDateTime(new Date());
  setMemberPickerValue(input.id, input.value);
}

function updateOpenGymWarning(selectedButton) {
  const warning = document.getElementById("openGymWarning");

  if (!warning) return;

  warning.hidden = selectedButton.textContent.trim() !== "Open Gym" || isOpenGymWindow(new Date());
}

function updateHeaterGroupPayFields(selectedButton) {
  const selectedValue = selectedButton?.dataset.heaterGroupPay
    || document.querySelector("[data-heater-group-pay].is-selected")?.dataset.heaterGroupPay
    || "";
  const singleField = document.getElementById("heaterResponsiblePartyField");
  const multiField = document.getElementById("heaterResponsiblePartiesField");

  if (!singleField || !multiField) return;

  singleField.hidden = selectedValue !== "N";
  multiField.hidden = selectedValue !== "Y";

  if (selectedButton && selectedValue === "N") {
    setMultiMemberPickerValue("heaterResponsibleMembers", []);
  } else if (selectedButton && selectedValue === "Y") {
    setMemberPickerValue("heaterResponsibleMember", "");
    const heaterPin = document.getElementById("heaterPin");
    if (heaterPin) {
      heaterPin.value = "";
    }
  }
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

  const client = await createSupabaseClient();

  if (!client) {
    showDetailActionMessage("App data is not available.");
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

    const { error } = await client
      .from("timesheet_entries")
      .insert(rows);

    if (error) {
      throw error;
    }

    if (firstValidMember) {
      triggerGymLightsOnSequence(firstValidMember.memberName).catch((sequenceError) => {
        console.warn("Gym lights on sequence failed.", sequenceError);
      });
    }

    await hydrateFromSupabase();
    render("currentlySignedIn");
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
  const guestName = String(form?.querySelector('input[type="text"]')?.value || "").trim();
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

  const client = await createSupabaseClient();

  if (!client) {
    showDetailActionMessage("App data is not available.");
    return;
  }

  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
  }

  try {
    const { error } = await client
      .from("timesheet_entries")
      .insert({
        member_or_guest: "Guest",
        guest_name: guestName,
        day_pass_or_open_gym: passType,
        member_entered_with_id: memberEnteredWithId,
        liability_accepted: true,
        signed_in_at: new Date().toISOString()
      });

    if (error) {
      throw error;
    }

    await hydrateFromSupabase();
    render("currentlySignedIn");
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

  const turnHeaterOn = String(form.querySelector('[aria-label="Turn heater on"] .segment.is-selected')?.textContent || "").trim();
  const eventName = String(form.querySelector('[aria-label="Heater event"] .choice-segment.is-selected')?.textContent || "").trim();
  const groupPayValue = String(form.querySelector('[aria-label="Group pay"] .segment.is-selected')?.dataset.heaterGroupPay || "").trim();
  const timerEnabledValue = String(form.querySelector('[aria-label="Add timer"] .segment.is-selected')?.dataset.heaterTimerEnabled || "N").trim();
  const timerMode = String(form.querySelector('[aria-label="Timer type"] .segment.is-selected')?.dataset.heaterTimerMode || "duration").trim();
  const timerDurationMinutes = Number(document.getElementById("heaterTimerDuration")?.value || 0);
  const timerUntilValue = String(document.getElementById("heaterTimerUntil")?.value || "").trim();
  const note = String(form.querySelector("textarea")?.value || "").trim();
  const singleResponsibleMemberId = String(document.getElementById("heaterResponsibleMember")?.value || "").trim();
  const multiResponsibleMemberIds = selectedMemberIdsFromInput(document.getElementById("heaterResponsibleMembers"));
  const heaterPin = String(document.getElementById("heaterPin")?.value || "").trim();

  if (!["On", "Off"].includes(turnHeaterOn)) {
    showDetailActionMessage("Select heater state: On or Off.");
    return;
  }

  if (!eventName) {
    showDetailActionMessage("Select an event.");
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

  if (groupPayValue === "N" && !/^\d{4}$/.test(heaterPin)) {
    showDetailActionMessage("Enter the 4-digit heater PIN.");
    return;
  }

  const client = await createSupabaseClient();

  if (!client) {
    showDetailActionMessage("App data is not available.");
    return;
  }

  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
  }

  try {
    const groupPay = groupPayValue === "Y";
    const responsibleMemberId = groupPay ? (multiResponsibleMemberIds[0] || null) : singleResponsibleMemberId;
    const usedOn = formatDateOnly(new Date());
    const now = new Date();
    const timerStart = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:00`;
    let timerStop = null;

    if (timerEnabled && timerMode === "duration") {
      const stopDate = new Date(now.getTime() + (timerDurationMinutes * 60000));
      timerStop = `${String(stopDate.getHours()).padStart(2, "0")}:${String(stopDate.getMinutes()).padStart(2, "0")}:00`;
    } else if (timerEnabled && timerMode === "until") {
      timerStop = `${timerUntilValue}:00`;
    }

    if (!groupPay && responsibleMemberId) {
      await verifyHeaterPin(responsibleMemberId, heaterPin);
    }

    const { data: createdEntry, error } = await client
      .from("heater_use_entries")
      .insert({
        used_on: usedOn,
        event: eventName,
        responsible_member_id: responsibleMemberId,
        group_pay: groupPay,
        turn_heater_on: turnHeaterOn,
        set_a_timer: timerEnabled,
        timer_start: timerEnabled ? timerStart : null,
        timer_stop: timerEnabled ? timerStop : null,
        start_at: new Date().toISOString(),
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

    if (turnHeaterOn === "On") {
      const smsRecipients = groupPay ? multiResponsibleMemberIds : [singleResponsibleMemberId];
      triggerHeaterOnSequence(smsRecipients).catch((sequenceError) => {
        console.warn("Heater on sequence failed.", sequenceError);
      });
    } else if (turnHeaterOn === "Off") {
      const smsRecipients = groupPay ? multiResponsibleMemberIds : [singleResponsibleMemberId];
      triggerHeaterOffSequence(smsRecipients, {
        heaterUseEntryId: createdEntry?.id || null,
        timerTriggered: false
      }).catch((sequenceError) => {
        console.warn("Heater off sequence failed.", sequenceError);
      });
    }

    await hydrateFromSupabase();
    render("heaterRecords");
  } catch (error) {
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
        group.querySelectorAll(".segment").forEach((segment) => {
          segment.classList.toggle("is-selected", segment === button);
        });
        updateOpenGymWarning(button);
        updateHeaterGroupPayFields(button);
        updateHeaterTimerFields(button);
      });
    });
  });

  document.querySelectorAll(".event-choice-grid").forEach((group) => {
    group.querySelectorAll(".choice-segment").forEach((button) => {
      button.addEventListener("click", () => {
        group.querySelectorAll(".choice-segment").forEach((segment) => {
          segment.classList.toggle("is-selected", segment === button);
        });
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

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js", { scope: "./" })
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
