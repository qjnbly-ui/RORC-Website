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
const APP_REFRESH_ROUTE_KEY = "rorc-app-refresh-route";
const APP_INVALID_SESSION_REFRESH_KEY = "rorc-app-invalid-session-refreshing";
const FACILITY_TIME_ZONE = "America/Los_Angeles";
let supabaseClient = null;
let currentAuthSession = null;
let deferredInstallPrompt = null;
let installFallbackTimer = null;
let appReloadingForUpdate = false;
let invalidSessionRefreshTimer = null;

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
let heaterEntriesRealtimeChannel = null;
let heaterEntriesRealtimeRetryTimer = null;
let heaterEntriesSyncInFlight = false;
let heaterEntriesSyncPending = false;
let heaterEntriesSyncNeedsRender = false;
let recentGuestWindowTimer = null;
let heaterCountdownTimer = null;
let thermostatStatus = null;
let thermostatStatusFetchedAt = 0;
const THERMOSTAT_STATUS_CACHE_MS = 60 * 1000;
const GUEST_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const pendingHeaterAutoOffIds = new Set();
let thermostatActionFeedback = null;
let notifiedIds = new Set();
let notificationUnreadCount = 0;
let contractReviewPendingCount = 0;
let rentalReviewsPendingCount = 0;
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
  "Rental Account",
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
    "Rental Account": {
      accountType: "Rental Account",
      canSignIn: false,
      bypassTimeWindows: false,
      allowedDays: [],
      allowedStartTime: null,
      allowedEndTime: null
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
  if (normalized === "rental account") return "Rental Account";
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
  "adminNotes",
  "rentalReviews"
]);

const kioskAllowedRoutes = new Set([
  "memberSignIn",
  "guestSignIn",
  "currentlySignedIn",
  "heaterRecords",
  "heaterForm",
  "notifications",
  "feedback",
  "about",
  "share",
  "calendar"
]);

const rentalAccountAllowedRoutes = new Set([
  "myAccount",
  "notifications",
  "feedback",
  "about",
  "share",
  "calendar",
  "myEvents"
]);

let frontDoorSession = buildSession("");
let appUserSession = buildSession("");
let routeRenderSequence = 0;

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
  rentalReviews: {
    title: "Rentals",
    template: "feedbackTemplate",
    afterRender: renderRentalReviewsPage
  },
  calendar: {
    title: "Calendar",
    template: "feedbackTemplate",
    afterRender: renderCalendarPage
  },
  myEvents: {
    title: "My Events",
    template: "feedbackTemplate",
    afterRender: renderMyEventsPage
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
  const localMember = accountMembers.find((member) => member.id === memberId);
  const directoryMember = globalMemberDirectory.find((member) => member.id === memberId);
  if (localMember && directoryMember) {
    return {
      ...directoryMember,
      ...localMember,
      mailingAddress: localMember.mailingAddress || directoryMember.mailingAddress || ""
    };
  }
  return localMember || directoryMember;
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

function isSpecialAccessAccount(memberOrSession) {
  return canonicalAccountType(memberOrSession?.accountType) === "Special Access Account";
}

function isRentalAccount(memberOrSession) {
  return canonicalAccountType(memberOrSession?.accountType) === "Rental Account";
}

function canOwnCalendarEvents(memberOrSession) {
  const accountType = canonicalAccountType(memberOrSession?.accountType);
  return Boolean(memberOrSession?.memberId || memberOrSession?.id)
    && accountType !== "RESTRICTED ACCOUNT"
    && accountType !== "Kiosk Account"
    && accountType !== "Rental Account";
}

function canViewOwnedCalendarEvents(memberOrSession) {
  const accountType = canonicalAccountType(memberOrSession?.accountType);
  return Boolean(memberOrSession?.memberId || memberOrSession?.id)
    && accountType !== "RESTRICTED ACCOUNT"
    && accountType !== "Kiosk Account";
}

function isRestrictedAccount(memberOrSession) {
  return canonicalAccountType(memberOrSession?.accountType) === "RESTRICTED ACCOUNT";
}

function canViewCalendarRoute(memberOrSession = appUserSession) {
  return Boolean(memberOrSession?.memberId) && !isRestrictedAccount(memberOrSession);
}

function canRequestCalendarEventChanges(memberOrSession = appUserSession) {
  return canOwnCalendarEvents(memberOrSession) && !isAccountManager(memberOrSession);
}

function canViewMyEventsRoute(memberOrSession = appUserSession) {
  return canViewOwnedCalendarEvents(memberOrSession) && hasOwnedCalendarEvents;
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

function isReloadNavigation() {
  const entry = performance.getEntriesByType?.("navigation")?.[0];
  return entry?.type === "reload";
}

function storedRefreshRoute() {
  if (!isReloadNavigation()) return "";
  try {
    const routeName = sessionStorage.getItem(APP_REFRESH_ROUTE_KEY) || "";
    return routes[routeName] ? routeName : "";
  } catch {
    return "";
  }
}

function rememberRefreshRoute(routeName) {
  if (!routes[routeName]) return;
  try {
    sessionStorage.setItem(APP_REFRESH_ROUTE_KEY, routeName);
  } catch {
    // Session storage can be unavailable in some private browsing contexts.
  }
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

async function renderAutomationSettingsPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;

  deferContentUntilReady(root);

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

  await bindAutomationSettingsActions({ silentInitialLoad: true });
  revealReadyContent(root);
}

function renderAccountTypePolicyFields() {
  const orderedTypes = ["Account Manager", "Kiosk Account", "Special Access Account", "Active Membership", "Weight Room Only", "Open Gym Only", "Rental Account", "RESTRICTED ACCOUNT"];
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

  deferContentUntilReady(root);

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
    revealReadyContent(root);
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
  revealReadyContent(root);

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
    <li data-contract-review-id="${escapeAttribute(review.id)}" data-contract-review-email="${escapeAttribute(review.applicantEmail || "")}">
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
        <div class="contract-review-action-panel" data-contract-review-panel="${escapeAttribute(review.id)}"></div>
      ` : ""}
    </li>
  `;
}

function bindContractReviewActions() {
  document.querySelectorAll("[data-contract-review-action]").forEach((button) => {
    button.addEventListener("click", () => {
      showContractReviewActionForm(button);
    });
  });
}

function showContractReviewActionForm(button) {
  const contractId = button.dataset.contractReviewId;
  const action = button.dataset.contractReviewAction;
  const row = button.closest("[data-contract-review-id]");
  const panel = row?.querySelector(`[data-contract-review-panel="${CSS.escape(contractId)}"]`);
  if (!contractId || !action || !panel) return;

  const isReject = action === "reject";
  const hasEmail = Boolean(String(row.dataset.contractReviewEmail || "").trim());
  panel.innerHTML = `
      <div class="admin-message-action-form">
        <div class="admin-message-description">
          <span class="admin-message-label-row">
            <span>Description ${isReject ? "<mark>*</mark>" : ""}</span>
            ${hasEmail ? "" : "<span class=\"admin-delivery-notice is-muted\">No email address on file</span>"}
          </span>
          <textarea class="rental-action-textarea" id="contract-review-notes-${escapeAttribute(contractId)}" rows="3"
            placeholder="${isReject ? "Reason for rejecting this account..." : "Optional approval note..."}"></textarea>
        </div>
        <div class="rental-action-btns">
          <button class="rental-btn rental-btn-ghost" data-contract-review-back="${escapeAttribute(contractId)}" type="button">Back</button>
          <button class="rental-btn ${isReject ? "rental-btn-decline" : "rental-btn-confirm"}" data-contract-review-submit="${escapeAttribute(contractId)}" type="button">
            ${isReject ? "Reject Account" : "Approve Account"}
          </button>
        </div>
        <p class="rental-action-error" id="contract-review-error-${escapeAttribute(contractId)}" hidden></p>
    </div>
  `;

  const textarea = panel.querySelector(`#contract-review-notes-${CSS.escape(contractId)}`);
  const error = panel.querySelector(`#contract-review-error-${CSS.escape(contractId)}`);

  panel.querySelector("[data-contract-review-back]")?.addEventListener("click", () => {
    panel.innerHTML = "";
  });

  panel.querySelector("[data-contract-review-submit]")?.addEventListener("click", () => {
    const notes = textarea?.value.trim() || "";
    if (isReject && !notes) {
      if (error) {
        error.textContent = "Description is required when rejecting.";
        error.hidden = false;
      }
      return;
    }
    submitContractReview(contractId, action, notes);
  });
}

async function submitContractReview(contractId, action, notes = "") {
  const result = document.getElementById("contractReviewResult");

  if (action === "reject" && !notes) {
    if (result) result.textContent = "Rejection notes are required.";
    return;
  }

  const automationConfirmed = await confirmAutomatedEmailBeforeSave({
    type: "signup_review",
    contractId,
    action,
    notes
  }, {
    title: action === "approve" ? "Approve Account?" : "Reject Account?",
    message: "This admin action has an automated email scheduled for the applicant.",
    confirmLabel: action === "approve" ? "Approve & Send Email" : "Reject & Send Email"
  });
  if (!automationConfirmed) {
    if (result) result.textContent = "No changes saved.";
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
              ${renderScheduledMessageActions(record)}
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

  bindScheduledMessageActions();
  bindNotificationOpenActions();
}

function renderScheduledMessageActions(record) {
  const scheduledMessageId = String(record.scheduledMessageId || "").trim();
  if (!scheduledMessageId) return "";

  const actions = [];
  if (record.canCancelScheduled) {
    actions.push(`
      <button
        class="rental-btn rental-btn-ghost notification-message-action"
        data-notification-scheduled-action="cancel"
        data-notification-scheduled-id="${escapeAttribute(scheduledMessageId)}"
        type="button"
      >Cancel Scheduled</button>
    `);
  }
  if (record.canDeleteScheduled) {
    actions.push(`
      <button
        class="rental-btn rental-btn-decline notification-message-action"
        data-notification-scheduled-action="delete"
        data-notification-scheduled-id="${escapeAttribute(scheduledMessageId)}"
        type="button"
      >Delete</button>
    `);
  }

  return actions.length
    ? `<div class="rental-card-btn-row notification-history-actions">${actions.join("")}</div>`
    : "";
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

  deferContentUntilReady(root);

  try {
    adminNotes = await fetchAdminNotes();
    drawAdminNotesPage();
  } catch (error) {
    revealReadyContent(root);
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
  revealReadyContent(root);

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

function toFacilityDatetimeLocalValue(isoString) {
  if (!isoString) return "";
  const value = new Date(isoString);
  if (Number.isNaN(value.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(value).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});

  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

function fromDatetimeLocalValue(localValue) {
  if (!localValue) return null;
  const value = new Date(localValue);
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

function fromFacilityDatetimeLocalValue(localValue) {
  const raw = String(localValue || "").trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) return null;
  return facilityWallTimeToIso(match[1], match[2]) || null;
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
            <span>${escapeHtml(thermostatSystemLabel(record.systemType))} State</span>
            <select id="masterLogHeaterState" ${readonlyAttribute}>
              <option value="On" ${(record.turnHeaterOn || "On") === "On" ? "selected" : ""}>On</option>
              <option value="Off" ${(record.turnHeaterOn || "On") === "Off" ? "selected" : ""}>Off</option>
            </select>
          </label>
          <label>
            <span>Target Temperature</span>
            <input id="masterLogTargetTemp" type="number" min="${normalizeThermostatSystemType(record.systemType) === "ac" ? "64" : "45"}" max="80" value="${escapeAttribute(record.targetTemperatureF || "")}" ${readonlyAttribute} />
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
        ${!isTimesheet ? `<button class="master-log-verify-runtime" type="button">Verify Runtime</button>` : ""}
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
  const verifyRuntimeButton = overlay.querySelector(".master-log-verify-runtime");

  verifyRuntimeButton?.addEventListener("click", async () => {
    const startAt = fromDatetimeLocalValue(String(overlay.querySelector("#masterLogHeaterStartAt")?.value || ""));
    const endAt = fromDatetimeLocalValue(String(overlay.querySelector("#masterLogHeaterEndAt")?.value || ""));
    const systemType = String(overlay.querySelector("#masterLogThermostatSystem")?.value || record.systemType || "heat");
    if (!startAt || !endAt) {
      setResult("Start At and End At are required before runtime verification.", "error");
      return;
    }

    verifyRuntimeButton.disabled = true;
    saveButton.disabled = true;
    deleteButton.disabled = true;
    if (removeBillingButton) removeBillingButton.disabled = true;
    setResult("Verifying runtime with Ecobee...");

    try {
      const runtime = await verifyThermostatRuntimeForRecord({
        systemType,
        startAt,
        endAt
      });
      const projectedEndLocal = toDatetimeLocalValue(runtime.projectedEndAt);
      if (projectedEndLocal) {
        const endInput = overlay.querySelector("#masterLogHeaterEndAt");
        if (endInput) endInput.value = projectedEndLocal;
      }
      const existingNote = String(overlay.querySelector("#masterLogHeaterNote")?.value || "").trim();
      const verifyNote = `[Runtime Verified ${formatShortDateTime(runtime.fetchedAt)}] ${runtime.systemType.toUpperCase()} runtime ${runtime.verifiedRuntimeMinutes} min (${runtime.rowsMatched} rows, source: ${runtime.source}).`;
      const nextNote = existingNote ? `${existingNote}\n${verifyNote}` : verifyNote;
      const noteField = overlay.querySelector("#masterLogHeaterNote");
      if (noteField) noteField.value = nextNote;
      setResult(`Runtime verified: ${runtime.verifiedRuntimeMinutes} min. End time updated for billing review.`, "success");
    } catch (error) {
      setResult(error.message || "Could not verify runtime.", "error");
    } finally {
      verifyRuntimeButton.disabled = false;
      saveButton.disabled = false;
      deleteButton.disabled = false;
      if (removeBillingButton) removeBillingButton.disabled = linkedBillingItems.length === 0;
    }
  });

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

function bindScheduledMessageActions() {
  document.querySelectorAll("[data-notification-scheduled-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const id = String(button.dataset.notificationScheduledId || "").trim();
      const action = String(button.dataset.notificationScheduledAction || "").trim();
      if (!id) return;

      if (action === "cancel") {
        void cancelScheduledMemberMessage(id);
      } else if (action === "delete") {
        void deleteScheduledMemberMessage(id);
      }
    });
  });
}

async function cancelScheduledMemberMessage(id) {
  const confirmed = await openLinkedDeleteDialog({
    title: "Cancel scheduled message?",
    message: "This keeps the history record but prevents the message from being sent.",
    confirmLabel: "Cancel Message",
    cancelLabel: "Keep Scheduled"
  });
  if (!confirmed) return;

  setScheduledMessageButtonsBusy(id, true, "Canceling...");
  try {
    await mutateScheduledMemberMessage(id, "cancel");
    await refreshMessageHistory();
    render("notificationsEmail");
    showAppNotice("Scheduled message canceled.");
  } catch (error) {
    setScheduledMessageButtonsBusy(id, false);
    showAppNotice(error.message || "Could not cancel scheduled message.", "Message Error");
  }
}

async function deleteScheduledMemberMessage(id) {
  const confirmed = await openLinkedDeleteDialog({
    title: "Delete scheduled message?",
    message: "This permanently deletes the scheduled message and removes it from message history. It cannot be undone.",
    confirmLabel: "Delete Message",
    cancelLabel: "Keep Message"
  });
  if (!confirmed) return;

  setScheduledMessageButtonsBusy(id, true, "Deleting...");
  try {
    await mutateScheduledMemberMessage(id, "delete");
    await refreshMessageHistory();
    render("notificationsEmail");
    showAppNotice("Scheduled message deleted.");
  } catch (error) {
    setScheduledMessageButtonsBusy(id, false);
    showAppNotice(error.message || "Could not delete scheduled message.", "Message Error");
  }
}

async function mutateScheduledMemberMessage(id, action) {
  const token = currentAuthSession?.access_token || "";
  if (!token) throw new Error("Please sign in again before updating the scheduled message.");

  const method = action === "delete" ? "DELETE" : "PATCH";
  const response = await fetch(`/api/message-history?id=${encodeURIComponent(id)}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: method === "DELETE" ? undefined : JSON.stringify({ id, action })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not update scheduled message.");
  }
  return body;
}

function setScheduledMessageButtonsBusy(id, busy, label = "") {
  document.querySelectorAll(`[data-notification-scheduled-id="${CSS.escape(id)}"]`).forEach((button) => {
    if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? (label || "Saving...") : button.dataset.defaultText;
  });
}

function bindNotificationOpenActions() {
  document.querySelectorAll("[data-notification-item]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target?.closest?.("button, a, input, select, textarea")) return;
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

  const localNow = toFacilityDatetimeLocalValue(new Date().toISOString());

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
          <span>Time & Date (Pacific)</span>
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

  const response = await fetch("/api/thermostat-status", {
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

async function verifyThermostatRuntimeForRecord({ systemType, startAt, endAt }) {
  const token = currentAuthSession?.access_token || "";
  if (!token) {
    throw new Error("You must be signed in to verify runtime.");
  }

  const response = await fetch("/api/verify-heater-runtime", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      systemType,
      startAt,
      endAt
    })
  });
  const rawText = await response.text();
  const body = parseJsonSafely(rawText);
  if (!response.ok || body.success === false) {
    const detail = body.error || rawText || "Could not verify thermostat runtime.";
    throw new Error(detail);
  }

  return body.runtime || null;
}

function parseJsonSafely(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
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
        sendAt: fromFacilityDatetimeLocalValue(sendAt) || sendAt
      });

      setResult(response.scheduled
        ? `Scheduled for ${formatFacilityShortDateTime(response.scheduledFor)}.`
        : `Sent. Texts: ${response.sentTextCount || 0}, Emails: ${response.sentEmailCount || 0}, In-App: ${response.sentInAppCount || 0}.`,
        "success");
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
  const orderedTypes = ["Account Manager", "Kiosk Account", "Special Access Account", "Active Membership", "Weight Room Only", "Open Gym Only", "Rental Account", "RESTRICTED ACCOUNT"];

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
  const orderedTypes = ["Account Manager", "Kiosk Account", "Special Access Account", "Active Membership", "Weight Room Only", "Open Gym Only", "Rental Account", "RESTRICTED ACCOUNT"];
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

async function bindAutomationSettingsActions({ silentInitialLoad = false } = {}) {
  const form = document.getElementById("automationSettingsForm");
  const saveButton = document.getElementById("automationSettingsSave");
  if (!form || !saveButton) return;
  const advancedToggle = document.getElementById("toggleAutomationAdvanced");
  const advancedFields = document.getElementById("automationAdvancedFields");

  try {
    if (!silentInitialLoad) automationResult("Loading settings...");
    const settings = await loadAutomationSettings();
    thermostatSystemAccess = normalizeThermostatSystemAccess(settings.thermostat_system_access || {});
    applyAutomationSettingsToForm(settings);
    refreshAutomationSectionStates();
    if (!silentInitialLoad) automationResult("Loaded.", "success");
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

function showInvalidSessionRefreshReturnMessage() {
  let shouldShow = false;
  try {
    shouldShow = sessionStorage.getItem(APP_INVALID_SESSION_REFRESH_KEY) === "1";
    sessionStorage.removeItem(APP_INVALID_SESSION_REFRESH_KEY);
  } catch {}
  if (!shouldShow) return;

  window.setTimeout(() => {
    if (!currentAuthSession) return;
    showAppNotice("Session refreshed.", "Session Restored");
  }, 600);
}

function setRouteViewPending(isPending) {
  if (view) {
    if (isPending) {
      view.setAttribute("aria-busy", "true");
    } else {
      view.removeAttribute("aria-busy");
    }
  }

  if (appShell) {
    appShell.classList.toggle("is-route-pending", Boolean(isPending));
  }
}

function deferContentUntilReady(element) {
  if (!element) return;
  element.innerHTML = "";
  element.hidden = true;
  element.setAttribute("aria-busy", "true");
}

function revealReadyContent(element) {
  if (!element) return;
  element.hidden = false;
  element.removeAttribute("aria-busy");
}

function renderRouteLoadError(route, error) {
  if (maybeRefreshForInvalidSession(error)) return;
  if (!view) return;
  view.innerHTML = `
    <section class="empty-state">
      <p>${escapeHtml(error?.message || `Could not load ${route?.title || "this page"}.`)}</p>
    </section>
  `;
}

function showRouteLoading(routeName) {
  routeRenderSequence += 1;
  const route = routes[routeName] || routes.currentlySignedIn;
  const activeRouteName = routeName === "accountDetails" ? appState.detailReturnRoute : routeName;
  const backRoute = Boolean(route.formRoute || route.detailRoute);

  if (screenTitle) {
    screenTitle.textContent = route.title || "";
  }
  if (appShell) {
    appShell.classList.toggle("is-form-route", Boolean(route.formRoute));
    appShell.classList.toggle("is-detail-route", Boolean(route.detailRoute));
  }
  if (navControl) {
    navControl.classList.toggle("is-back", backRoute);
    navControl.setAttribute("aria-label", backRoute ? "Go back" : "Open menu");
  }
  if (view) {
    view.innerHTML = `
      <section class="empty-state">
        <p>Loading ${escapeHtml((route.title || "page").toLowerCase())}…</p>
      </section>
    `;
  }
  setRouteViewPending(true);

  navItems.forEach((item) => {
    item.classList.toggle("is-active", item.dataset.route === activeRouteName);
  });
  drawerItems.forEach((item) => {
    item.classList.toggle("is-active", item.dataset.route === activeRouteName);
  });
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
  hasOwnedCalendarEvents = false;
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
  const rentalMode = isRentalAccount(appUserSession);
  const alwaysVisibleRoutes = new Set(["notifications", "about", "share", "feedback"]);
  const bottomNav = document.querySelector(".bottom-nav");
  if (bottomNav) {
    bottomNav.hidden = rentalMode;
  }
  navItems.forEach((item) => {
    item.hidden = rentalMode;
  });

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

  drawerItems
    .filter((item) => item.dataset.route === "calendar")
    .forEach((item) => {
      item.hidden = !canViewCalendarRoute(appUserSession);
    });

  drawerItems
    .filter((item) => item.dataset.route === "myEvents")
    .forEach((item) => {
      item.hidden = !canViewMyEventsRoute(appUserSession);
    });

  if (kioskMode) {
    drawerItems.forEach((item) => {
      const routeName = item.dataset.route;
      item.hidden = !["feedback", "notifications", "about", "share", "calendar"].includes(routeName)
        || (routeName === "calendar" && !canViewCalendarRoute(appUserSession));
    });
  }

  if (rentalMode) {
    drawerItems.forEach((item) => {
      const routeName = item.dataset.route;
      item.hidden = !rentalAccountAllowedRoutes.has(routeName)
        || (routeName === "calendar" && !canViewCalendarRoute(appUserSession))
        || (routeName === "myEvents" && !canViewMyEventsRoute(appUserSession));
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

function updateRentalReviewsBadge() {
  const badge = document.getElementById("drawerRentalReviewsBadge");
  if (!badge) return;
  const hasPending = isAccountManager(appUserSession) && rentalReviewsPendingCount > 0;
  badge.hidden = !hasPending;
  badge.textContent = hasPending ? String(rentalReviewsPendingCount) : "";
}

async function refreshRentalReviewsBadge() {
  if (!isAccountManager(appUserSession)) {
    rentalReviewsPendingCount = 0;
    updateRentalReviewsBadge();
    return;
  }

  const token = currentAuthSession?.access_token || "";
  if (!token) return;

  const response = await fetch("/api/rental-reviews", {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not load rental review count.");
  }

  rentalReviewsPendingCount = (body.requests || [])
    .filter((r) => r.rentalStatus === "submitted" || r.rentalStatus === "pending_review")
    .length;
  updateRentalReviewsBadge();
}

// ─────────────────────────────────────────────
// Rental Reviews — premium admin UI
// ─────────────────────────────────────────────

let rentalAllRequests  = [];
let rentalActiveFilter = "action"; // action | confirmed | special_access | declined | archive | all
let highlightRentalId  = null;     // deeplink from calendar
let rentalAutomationNotice = "";

const RENTAL_STATUS_LABEL = {
  submitted:      "Submitted",
  pending_review: "In Review",
  confirmed:      "Confirmed",
  rejected:       "Declined",
  canceled:       "Canceled"
};

const RENTAL_STATUS_COLOR = {
  submitted:      "#f59e0b",
  pending_review: "#f97316",
  confirmed:      "#22c55e",
  rejected:       "#ef4444",
  canceled:       "#737373"
};

const RENTAL_PRICE_CENTS = {
  allDay: 10000,
  hourlyRate: 1000,
  nonPrivateHourlyRate: 500,
  cleaningMaintenance: 2000,
  tables: 2000,
  chairs: 2000,
  tarp: 2000,
  heater: 0,
  ac: 0,
  earlySetup: 5000,
  earlyDayRental: 10000,
  lateCleanup: 5000,
  lateDayRental: 10000
};

const SPECIAL_ACCESS_RENTAL_DISCOUNT_RATE = 0.2;

function normalizeRentalHours(value, fallback = 1) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(9, Math.max(0.01, Math.round(hours * 100) / 100));
}

function normalizeRentalBillableHours(value, fallback = 1) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(24, Math.max(0.01, Math.round(hours * 100) / 100));
}

function rentalHoursFromMinutes(minutes) {
  return normalizeRentalHours(Number(minutes) / 60, 0);
}

function rentalHoursValue(hours) {
  const normalized = normalizeRentalHours(hours);
  return String(Number(normalized.toFixed(2)));
}

function rentalHoursLabel(hours) {
  const normalized = normalizeRentalHours(hours);
  const label = rentalHoursValue(normalized);
  return `${label} hr${normalized === 1 ? "" : "s"}`;
}

function rentalBillableHoursLabel(hours) {
  const normalized = normalizeRentalBillableHours(hours);
  const label = String(Number(normalized.toFixed(2)));
  return `${label} hr${normalized === 1 ? "" : "s"}`;
}

function rentalHoursBetween(startValue, endValue, fallback = 1) {
  const start = minutesFromTimeValue(normalizeTimeFieldValue(startValue));
  const end = minutesFromTimeValue(normalizeTimeFieldValue(endValue));
  if (start === null || end === null || end <= start) return fallback;
  return normalizeRentalBillableHours((end - start) / 60, fallback);
}

function rentalBaseCents(values) {
  const isPrivateEvent = values?.isPrivateEvent !== false;
  if (!isPrivateEvent) {
    const accessHours = rentalHoursBetween(values?.rentalAccessStart, values?.rentalAccessEnd, values?.rentalHours || 1);
    return Math.round(normalizeRentalBillableHours(accessHours) * RENTAL_PRICE_CENTS.nonPrivateHourlyRate);
  }

  const rentalType = values?.rentalType === "hourly" ? "hourly" : "all_day";
  const hours = normalizeRentalHours(rentalHoursBetween(values?.rentalAccessStart, values?.rentalAccessEnd, values?.rentalHours || 1));
  return rentalType === "hourly"
    ? Math.round(hours * RENTAL_PRICE_CENTS.hourlyRate)
    : RENTAL_PRICE_CENTS.allDay;
}

function openLinkedDeleteDialog({
  title = "Delete item?",
  message = "This action cannot be undone.",
  confirmLabel = "Delete",
  cancelLabel = "Cancel"
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "member-delete-confirm-overlay";
    overlay.style.position = "fixed";
    overlay.style.zIndex = "1200";
    overlay.innerHTML = `
      <section class="member-delete-confirm-dialog" role="dialog" aria-modal="true" aria-label="Delete confirmation">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <footer>
          <button class="member-delete-confirm-cancel" type="button">${escapeHtml(cancelLabel)}</button>
          <button class="member-delete-confirm-accept" type="button">${escapeHtml(confirmLabel)}</button>
        </footer>
      </section>
    `;

    const close = (confirmed) => {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(confirmed);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") close(false);
    };

    overlay.querySelector(".member-delete-confirm-cancel")?.addEventListener("click", () => close(false));
    overlay.querySelector(".member-delete-confirm-accept")?.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKeydown);
    document.body.appendChild(overlay);
  });
}

async function fetchLinkedCalendarEventIdForRental(rentalRequestId) {
  const token = currentAuthSession?.access_token || "";
  if (!token || !rentalRequestId) return "";
  const res = await fetch("/api/events", {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) return "";
  const linked = (body.events || []).find((ev) => ev.rentalRequestId === rentalRequestId && ev.status !== "cancelled");
  return linked?.id || "";
}

function calculateRentalTotalCents(values) {
  let total = rentalBaseCents(values);

  if (values?.addonCleaningMaintenance) total += RENTAL_PRICE_CENTS.cleaningMaintenance;
  if (values?.addonTables) total += RENTAL_PRICE_CENTS.tables;
  if (values?.addonChairs) total += RENTAL_PRICE_CENTS.chairs;
  if (values?.addonTarp) total += RENTAL_PRICE_CENTS.tarp;
  if (values?.addonHeater) total += RENTAL_PRICE_CENTS.heater;
  if (values?.addonAc) total += RENTAL_PRICE_CENTS.ac;
  if (values?.addonEarlySetup) total += RENTAL_PRICE_CENTS.earlySetup;
  if (values?.addonEarlyDayRental) total += RENTAL_PRICE_CENTS.earlyDayRental;
  if (values?.addonLateCleanup) total += RENTAL_PRICE_CENTS.lateCleanup;
  if (values?.addonLateDayRental) total += RENTAL_PRICE_CENTS.lateDayRental;
  if (values?.specialAccessDiscount) {
    total = Math.round(total * (1 - SPECIAL_ACCESS_RENTAL_DISCOUNT_RATE));
  }
  return total;
}

function rentalDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isRentalNeedsAction(rental) {
  return rental?.rentalStatus === "submitted" || rental?.rentalStatus === "pending_review";
}

function isRentalDeclined(rental) {
  return rental?.rentalStatus === "rejected" || rental?.rentalStatus === "canceled";
}

function isRentalPast(rental) {
  const eventDate = String(rental?.eventDate || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(eventDate) && eventDate < rentalDateKey();
}

function isRentalSpecialAccess(rental) {
  return Boolean(rental?.specialAccessDiscount);
}

function rentalFilterKeyForRequest(rental) {
  if (!rental) return "all";
  if (isRentalNeedsAction(rental)) return "action";
  if (isRentalPast(rental)) return "archive";
  if (rental.rentalStatus === "confirmed" && isRentalSpecialAccess(rental)) return "special_access";
  if (rental.rentalStatus === "confirmed") return "confirmed";
  if (isRentalDeclined(rental)) return "declined";
  return "all";
}

function inferRentalCleaningMaintenance(rental) {
  if (typeof rental?.addonCleaningMaintenance === "boolean") return rental.addonCleaningMaintenance;
  const storedTotal = Number(rental?.estimatedTotalCents || 0);
  if (!storedTotal) return false;
  const pricingValues = {
    rentalType: rental.rentalType,
    rentalHours: rental.rentalHours,
    rentalAccessStart: rental.eventStartTime,
    rentalAccessEnd: rental.eventEndTime,
    isPrivateEvent: rental.isPrivateEvent,
    specialAccessDiscount: rental.specialAccessDiscount,
    addonTables: rental.addonTables,
    addonChairs: rental.addonChairs,
    addonTarp: rental.addonTarp,
    addonHeater: rental.addonHeater,
    addonAc: rental.addonAc,
    addonEarlySetup: rental.addonEarlySetup,
    addonEarlyDayRental: rental.addonEarlyDayRental,
    addonLateCleanup: rental.addonLateCleanup,
    addonLateDayRental: rental.addonLateDayRental
  };
  const totalWithCleaning = calculateRentalTotalCents({
    ...pricingValues,
    addonCleaningMaintenance: true
  });
  return storedTotal >= totalWithCleaning;
}

async function renderRentalReviewsPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;
  root.classList.add("rental-admin-page");

  deferContentUntilReady(root);

  try {
    const token = currentAuthSession?.access_token || "";
    if (!token) throw new Error("Sign in to view rental requests.");

    const res  = await fetch("/api/rental-reviews", { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) throw new Error(body.error || "Could not load rental requests.");

    rentalAllRequests = body.requests || [];
    rentalReviewsPendingCount = rentalAllRequests.filter(
      (r) => r.rentalStatus === "submitted" || r.rentalStatus === "pending_review"
    ).length;
    updateRentalReviewsBadge();
    renderRentalPipeline(root);
  } catch (err) {
    revealReadyContent(root);
    root.innerHTML = `<p class="feedback-empty">${escapeHtml(err.message)}</p>`;
  }
}

function renderRentalPipeline(root) {
  revealReadyContent(root);

  const all       = rentalAllRequests;
  const action    = all.filter(isRentalNeedsAction);
  const archive   = all.filter((r) => !isRentalNeedsAction(r) && isRentalPast(r));
  const confirmed = all.filter((r) => r.rentalStatus === "confirmed" && !isRentalPast(r) && !isRentalSpecialAccess(r));
  const specialAccess = all.filter((r) => r.rentalStatus === "confirmed" && !isRentalPast(r) && isRentalSpecialAccess(r));
  const declined  = all.filter((r) => isRentalDeclined(r) && !isRentalPast(r));

  const filtered = rentalActiveFilter === "action"    ? action
                 : rentalActiveFilter === "confirmed" ? confirmed
                 : rentalActiveFilter === "special_access" ? specialAccess
                 : rentalActiveFilter === "declined"  ? declined
                 : rentalActiveFilter === "archive"   ? archive
                 : all;

  const tabs = [
    { key: "action",    label: "Needs Action",   count: action.length },
    { key: "confirmed", label: "Confirmed",      count: confirmed.length },
    { key: "special_access", label: "Special Access", count: specialAccess.length },
    { key: "declined",  label: "Declined",       count: declined.length },
    { key: "archive",   label: "Archive",        count: archive.length },
    { key: "all",       label: "All",            count: all.length }
  ];
  const activeFilterLabel = tabs.find((t) => t.key === rentalActiveFilter)?.label.toLowerCase() || "";

  root.innerHTML = `
    <section class="live-record-page rental-admin-shell">
      ${rentalAutomationNotice ? `<p class="feedback-error rental-automation-notice">${escapeHtml(rentalAutomationNotice)}</p>` : ""}

      <div class="detail-card">
        <div class="rental-filter-tabs master-logs-tabs" role="tablist" aria-label="Rental request filters">
          ${tabs.map((t) => `
            <button class="rental-filter-tab master-logs-tab${rentalActiveFilter === t.key ? " is-active" : ""}"
                    data-filter="${escapeAttribute(t.key)}" role="tab"
                    aria-selected="${rentalActiveFilter === t.key}" type="button">
              ${escapeHtml(t.label)}
              ${t.count ? `<span class="rental-filter-count">${t.count}</span>` : ""}
            </button>`).join("")}
        </div>
      </div>

      ${filtered.length ? `
        <div id="rental-cards-list" class="rental-cards">
          ${filtered.map((r) => buildRentalCard(r)).join("")}
        </div>
      ` : `
        <section id="rental-cards-list" class="empty-state">
          <p>No ${rentalActiveFilter === "all" || !activeFilterLabel ? "" : activeFilterLabel + " "}requests.</p>
        </section>
      `}

      <button class="heater-fab rental-fab is-icon-only" type="button" aria-label="Create new rental">
        <span class="heater-fab-icon" aria-hidden="true">+</span>
      </button>
    </section>
  `;

  // Filter tabs
  root.querySelectorAll(".rental-filter-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      rentalActiveFilter = btn.dataset.filter;
      renderRentalPipeline(root);
    });
  });

  // All inline action buttons
  root.querySelectorAll("[data-rental-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleRentalAction(btn, root));
  });

  root.querySelectorAll("[data-rental-edit]").forEach((btn) => {
    btn.addEventListener("click", () => showRentalEditForm(btn.dataset.rentalEdit, root));
  });

  root.querySelectorAll("[data-rental-notify]").forEach((btn) => {
    btn.addEventListener("click", () => openRentalNotifyDialog(btn.dataset.rentalNotify));
  });

  root.querySelectorAll("[data-rental-change-review]").forEach((btn) => {
    btn.addEventListener("click", () => reviewRentalChangeRequest(btn, root));
  });

  // Calendar crosslinks
  root.querySelectorAll("[data-rental-view-calendar]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const date = btn.dataset.rentalViewCalendar;
      calendarJumpToDate(date);
      navigateTo("calendar");
    });
  });

  root.querySelector(".rental-fab")?.addEventListener("click", () => {
    pendingCalendarRentalCreate = true;
    render("calendar");
  });

  // Scroll to highlighted request if coming from calendar
  if (highlightRentalId) {
    const card = root.querySelector(`[data-rental-id="${highlightRentalId}"]`);
    if (card) {
      card.classList.add("rental-card-highlight");
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      const highlightedRental = rentalAllRequests.find((r) => r.id === highlightRentalId);
      const nextFilter = highlightedRental ? rentalFilterKeyForRequest(highlightedRental) : "all";
      if (nextFilter !== rentalActiveFilter) {
        rentalActiveFilter = nextFilter;
        renderRentalPipeline(root);
        return;
      }
    }
    highlightRentalId = null;
  }
}

function buildRentalCard(r) {
  const status      = r.rentalStatus || "submitted";
  const statusLabel = RENTAL_STATUS_LABEL[status] || status;
  const statusColor = RENTAL_STATUS_COLOR[status] || "#8a97a8";

  const totalDollars = r.estimatedTotalCents
    ? formatCurrency(r.estimatedTotalCents)
    : null;

  const accessHours = rentalHoursBetween(r.eventStartTime, r.eventEndTime, r.rentalHours || 1);
  const rentalTypeLabel = r.isPrivateEvent === false
    ? `Non-private (${rentalBillableHoursLabel(accessHours)} @ $5/hr)`
    : r.rentalType === "hourly"
      ? `${rentalHoursLabel(accessHours)} @ $10/hr`
      : "All Day";

  const eventDate = r.eventDate
    ? new Date(r.eventDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" })
    : "—";

  const timeRange = (r.eventStartTime && r.eventEndTime)
    ? `${r.eventStartTime} – ${r.eventEndTime}`
    : r.eventStartTime || "";

  const addons = [
    r.isPrivateEvent === false && "Non-private event",
    r.specialAccessDiscount && "Special Access 20% discount",
    r.addonTables        && "Tables",
    r.addonChairs        && "Chairs",
    r.addonTarp          && "Tarp",
    r.addonHeater        && "Heater",
    r.addonAc            && "AC ($2/hr)",
    inferRentalCleaningMaintenance(r) && "Standard Maintenance Fee",
    r.addonEarlySetup    && "Early Setup",
    r.addonEarlyDayRental && "Extra Day (Early)",
    r.addonLateCleanup   && "Late Cleanup",
    r.addonLateDayRental && "Extra Day (Late)"
  ].filter(Boolean);

  const isActionable = status === "submitted" || status === "pending_review";
  const isConfirmed  = status === "confirmed";
  const isRejected = status === "rejected";
  const pendingRenterRequests = (r.changeRequests || []).filter((request) => request.status === "pending");
  const editButton = `<button class="rental-btn rental-btn-ghost" data-rental-edit="${escapeAttribute(r.id)}" type="button">Edit Booking</button>`;
  const notifyButton = `<button class="rental-btn rental-btn-ghost" data-rental-notify="${escapeAttribute(r.id)}" type="button">Notify Members</button>`;

  const actionsHtml = isActionable ? `
    <div class="rental-card-actions" id="rental-actions-${escapeAttribute(r.id)}">
      <div class="rental-card-btn-row">
        ${editButton}
        ${status === "submitted" ? `
          <button class="rental-btn rental-btn-ghost" data-rental-action="pending_review" data-rental-id="${escapeAttribute(r.id)}">Mark In Review</button>
        ` : ""}
        <button class="rental-btn rental-btn-decline" data-rental-action="decline" data-rental-id="${escapeAttribute(r.id)}">Decline</button>
        <button class="rental-btn rental-btn-confirm" data-rental-action="confirm" data-rental-id="${escapeAttribute(r.id)}">Confirm Booking</button>
        <button class="rental-btn rental-btn-decline" data-rental-action="delete" data-rental-id="${escapeAttribute(r.id)}">Delete Request</button>
      </div>
    </div>
  ` : isConfirmed ? `
    <div class="rental-card-actions" id="rental-actions-${escapeAttribute(r.id)}">
      <div class="rental-card-btn-row">
        ${editButton}
        ${notifyButton}
        <button class="rental-btn rental-btn-view-cal" data-rental-view-calendar="${escapeAttribute(r.eventDate || "")}">View on Calendar</button>
        <button class="rental-btn rental-btn-cancel" data-rental-action="cancel" data-rental-id="${escapeAttribute(r.id)}">Cancel Booking</button>
        <button class="rental-btn rental-btn-decline" data-rental-action="delete" data-rental-id="${escapeAttribute(r.id)}">Delete Request</button>
      </div>
    </div>
  ` : isRejected ? `
    <div class="rental-card-actions" id="rental-actions-${escapeAttribute(r.id)}">
      <div class="rental-card-btn-row">
        ${editButton}
        <button class="rental-btn rental-btn-ghost" data-rental-action="pending_review" data-rental-id="${escapeAttribute(r.id)}">Reopen Review</button>
        <button class="rental-btn rental-btn-confirm" data-rental-action="confirm" data-rental-id="${escapeAttribute(r.id)}">Confirm Booking</button>
        <button class="rental-btn rental-btn-decline" data-rental-action="delete" data-rental-id="${escapeAttribute(r.id)}">Delete Request</button>
      </div>
    </div>
  ` : `
    <div class="rental-card-actions" id="rental-actions-${escapeAttribute(r.id)}">
      <div class="rental-card-btn-row">
        ${editButton}
        <button class="rental-btn rental-btn-decline" data-rental-action="delete" data-rental-id="${escapeAttribute(r.id)}">Delete Request</button>
      </div>
    </div>
  `;

  return `
    <article class="rental-card" data-rental-id="${escapeAttribute(r.id)}" data-status="${escapeAttribute(status)}">

      <div class="rental-card-head">
        <span class="rental-card-type-badge">${escapeHtml(r.eventType || "Event")}</span>
        <span class="rental-card-status-pill" style="--status-color:${statusColor}">${escapeHtml(statusLabel)}</span>
      </div>

      <h3 class="rental-card-title">${escapeHtml(r.eventName || r.eventType || "Rental Request")}</h3>
      <p class="rental-card-contact-name">${escapeHtml(r.contactName || "")}</p>

      <div class="rental-card-divider"></div>

      <dl class="rental-card-grid">
        <div class="rental-card-field">
          <dt>Date</dt>
          <dd>${escapeHtml(eventDate)}</dd>
        </div>
        ${timeRange ? `
        <div class="rental-card-field">
          <dt>Time</dt>
          <dd>${escapeHtml(timeRange)}</dd>
        </div>` : ""}
        <div class="rental-card-field">
          <dt>Attendance</dt>
          <dd>${r.estimatedAttendance ? `${r.estimatedAttendance} guests` : "—"}</dd>
        </div>
        <div class="rental-card-field">
          <dt>Rental</dt>
          <dd>
            <span class="rental-card-pill">${escapeHtml(rentalTypeLabel)}</span>
          </dd>
        </div>
        <div class="rental-card-field">
          <dt>Est. Total</dt>
          <dd class="rental-card-total">${escapeHtml(totalDollars || "—")}</dd>
        </div>
      </dl>

      ${addons.length ? `
      <div class="rental-card-addons">
        ${addons.map((a) => `<span class="rental-card-addon-chip">${escapeHtml(a)}</span>`).join("")}
      </div>` : ""}

      <div class="rental-card-divider"></div>

      <dl class="rental-card-contact">
        <div class="rental-card-contact-row">
          <dt>Phone</dt><dd><a href="tel:${escapeAttribute(r.contactPhone || "")}">${escapeHtml(r.contactPhone || "—")}</a></dd>
        </div>
        <div class="rental-card-contact-row">
          <dt>Email</dt><dd><a href="mailto:${escapeAttribute(r.contactEmail || "")}">${escapeHtml(r.contactEmail || "—")}</a></dd>
        </div>
        <div class="rental-card-contact-row">
          <dt>Address</dt><dd>${escapeHtml(r.contactAddress || "—")}</dd>
        </div>
      </dl>

      ${pendingRenterRequests.length ? renderRentalChangeRequestPanel(r, pendingRenterRequests) : ""}

      ${r.adminNotes ? `
      <div class="rental-card-notes">
        <span class="rental-card-notes-label">Admin Notes</span>
        <p class="rental-card-notes-text">${escapeHtml(r.adminNotes)}</p>
      </div>` : ""}

      <div class="rental-card-footer">
        <span class="rental-card-timestamp">Submitted ${formatShortDateTime(r.createdAt)}</span>
        ${r.reviewedAt ? `<span class="rental-card-timestamp">Reviewed ${formatShortDateTime(r.reviewedAt)}</span>` : ""}
      </div>

      ${actionsHtml}
    </article>
  `;
}

function renderRentalChangeRequestPanel(rental, requests) {
  return `
    <div class="rental-card-notes rental-change-request-panel">
      <span class="rental-card-notes-label">Renter Requests</span>
      ${requests.map((request) => `
        <article class="rental-change-request-card">
          <div>
            <strong>${escapeHtml(request.requestType === "cancel" ? "Cancellation request" : "Change request")}</strong>
            ${renderRentalChangeRequestDetails(request)}
            <small>${escapeHtml(formatShortDateTime(request.createdAt))}</small>
          </div>
          <div class="rental-card-btn-row">
            <button class="rental-btn rental-btn-confirm" type="button" data-rental-change-review="approve" data-rental-change-id="${escapeAttribute(request.id)}" data-rental-id="${escapeAttribute(rental.id)}">Approve</button>
            <button class="rental-btn rental-btn-decline" type="button" data-rental-change-review="reject" data-rental-change-id="${escapeAttribute(request.id)}" data-rental-id="${escapeAttribute(rental.id)}">Reject</button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderRentalChangeRequestDetails(request) {
  const payload = request?.requestedPayload || {};
  if (request?.requestType === "cancel") {
    return `<p class="rental-card-notes-text">${escapeHtml(payload.message || "Renter requested cancellation.")}</p>`;
  }
  const rows = [];
  const hasField = (key) => Object.prototype.hasOwnProperty.call(payload, key);
  const addRow = (label, value) => {
    if (value === undefined || value === null || String(value).trim() === "") return;
    rows.push(`
      <div class="rental-change-request-row">
        <dt>${escapeHtml(label)}</dt>
        <dd>${escapeHtml(value)}</dd>
      </div>
    `);
  };

  addRow("Contact", payload.contact_name);
  addRow("Phone", payload.contact_phone);
  addRow("Email", payload.contact_email);
  addRow("Address", payload.contact_address);
  addRow("Event Name", payload.event_name);
  addRow("Event Type", payload.event_type);
  addRow("Date", payload.event_date);
  if (payload.event_start_time || payload.event_end_time) {
    addRow("Rental Access", `${payload.event_start_time || "?"} - ${payload.event_end_time || "?"}`);
  }
  if (payload.public_event_start_time || payload.public_event_end_time) {
    addRow("Public Event Time", `${payload.public_event_start_time || "?"} - ${payload.public_event_end_time || "?"}`);
  }
  addRow("Attendance", payload.estimated_attendance);
  if (hasField("food_or_drinks")) addRow("Food or Drinks", payload.food_or_drinks ? "Yes" : "No");
  addRow("Alcohol", payload.alcohol);
  if (hasField("is_private_event")) addRow("Private Event", payload.is_private_event ? "Yes" : "No");
  if (payload.rental_type) {
    const rentalType = payload.rental_type === "hourly" ? "By the Hour" : "All Day";
    addRow("Rental Type", payload.rental_type === "hourly" && payload.rental_hours
      ? `${rentalType} (${payload.rental_hours} hrs)`
      : rentalType);
  }
  const addonFields = [
    ["addon_cleaning_maintenance", "Standard Maintenance Fee"],
    ["addon_tables", "Tables"],
    ["addon_chairs", "Chairs"],
    ["addon_tarp", "Tarp"],
    ["addon_heater", "Heater"],
    ["addon_ac", "AC ($2/hr)"],
    ["addon_early_setup", "Early Setup"],
    ["addon_early_day_rental", "Extra Day (Early)"],
    ["addon_late_cleanup", "Late Cleanup"],
    ["addon_late_day_rental", "Extra Day (Late)"]
  ];
  if (addonFields.some(([key]) => hasField(key))) {
    const selectedAddons = addonFields
      .filter(([key]) => payload[key])
      .map(([, label]) => label);
    addRow("Add-ons", selectedAddons.length ? selectedAddons.join(", ") : "None");
  }
  addRow("Message", payload.adminNotes);

  if (!rows.length) {
    return `<p class="rental-card-notes-text">Renter requested booking changes.</p>`;
  }
  return `<dl class="rental-change-request-details">${rows.join("")}</dl>`;
}

async function reviewRentalChangeRequest(button, root) {
  const changeRequestId = String(button.dataset.rentalChangeId || "").trim();
  const action = String(button.dataset.rentalChangeReview || "").trim();
  if (!changeRequestId || !["approve", "reject"].includes(action)) return;
  const reviewNotes = window.prompt(action === "approve"
    ? "Optional approval notes for this renter request:"
    : "Optional rejection reason for this renter request:"
  ) || "";
  button.disabled = true;
  button.textContent = action === "approve" ? "Approving..." : "Rejecting...";
  try {
    const token = currentAuthSession?.access_token || "";
    if (!token) throw new Error("Please sign in again before reviewing.");
    const res = await fetch("/api/rental-reviews", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ changeRequestId, action, reviewNotes })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) throw new Error(body.error || "Could not review renter request.");

    rentalAutomationNotice = Array.isArray(body.automationWarnings) && body.automationWarnings.length
      ? `Saved, but automation needs attention: ${body.automationWarnings.join(", ")}. Check Vercel logs for details.`
      : "";
    if (body.request?.id) {
      const index = rentalAllRequests.findIndex((item) => item.id === body.request.id);
      if (index >= 0) rentalAllRequests[index] = body.request;
    }
    renderRentalPipeline(root);
  } catch (error) {
    rentalAutomationNotice = error.message || "Could not review renter request.";
    renderRentalPipeline(root);
  }
}

function openRentalNotifyDialog(rentalId) {
  const rental = rentalAllRequests.find((item) => item.id === rentalId);
  if (!rental) {
    showAppNotice("Rental request not found.");
    return;
  }

  const existing = document.querySelector(".rental-notify-overlay");
  if (existing) existing.remove();

  const defaults = rentalNotifyDefaults(rental);
  const scheduleOptions = rentalNotifyScheduleOptions(rental);
  const overlay = document.createElement("div");
  overlay.className = "communication-preview-overlay rental-notify-overlay";
  overlay.innerHTML = `
    <section class="communication-preview-dialog automation-confirm-dialog rental-notify-dialog" role="dialog" aria-modal="true" aria-label="Notify members of this event">
      <header>
        <div>
          <p class="eyebrow">Rental Notification</p>
          <h3>Notify members of this event</h3>
        </div>
      </header>

      <div class="communication-preview-meta">
        <span><strong>Rental</strong>${escapeHtml(rental.eventName || rental.eventType || "Rental")}</span>
        <span><strong>Date</strong>${escapeHtml(defaults.dateLabel)}</span>
      </div>

      <label class="cal-field-label">Title
        <input id="rentalNotifyTitle" class="rorc-input" type="text" value="${escapeAttribute(defaults.title)}" />
      </label>

      <div class="segmented-field">
        <span>Delivery Channels</span>
        <div class="segmented-control" data-multi-select="true">
          <button id="rentalNotifyText" class="segment" type="button" aria-pressed="false">Text</button>
          <button id="rentalNotifyEmail" class="segment is-selected" type="button" aria-pressed="true">Email</button>
          <button id="rentalNotifyInApp" class="segment is-selected" type="button" aria-pressed="true">In-App</button>
        </div>
      </div>

      <label class="cal-field-label">To Members
        <input id="rentalNotifyMembers" class="member-picker-value" type="hidden" />
        <button
          id="rentalNotifyMembersPicker"
          class="member-picker-button multi-member-picker-button"
          data-member-multi-picker="rentalNotifyMembers"
          data-member-picker-source="memberSignIn"
          data-member-picker-placeholder="Select members"
          data-member-picker-title="Notify Members"
          type="button"
        >
          <span class="member-picker-selected">
            <span class="member-picker-placeholder">Select members</span>
          </span>
          <span class="member-picker-plus" aria-hidden="true">+</span>
        </button>
      </label>
      <div class="rental-card-btn-row">
        <button id="rentalNotifySelectAll" class="rental-btn rental-btn-ghost" type="button">Select All Members</button>
        <button id="rentalNotifyClearMembers" class="rental-btn rental-btn-ghost" type="button">Clear</button>
      </div>
      <p id="rentalNotifyRecipientSummary" class="auth-message">No members selected.</p>

      <fieldset class="cal-recurring-ends">
        <legend>Send Timing (Pacific)</legend>
        ${scheduleOptions.map((option) => `
          <label>
            <input type="radio" name="rentalNotifyTiming" value="${escapeAttribute(option.key)}" data-send-at="${escapeAttribute(option.value || "")}" ${option.checked ? "checked" : ""} ${option.disabled ? "disabled" : ""} />
            ${escapeHtml(option.label)}
          </label>
        `).join("")}
        <input id="rentalNotifyCustomAt" class="rorc-input" type="datetime-local" value="${escapeAttribute(defaults.customLocal)}" disabled />
      </fieldset>

      <label class="cal-field-label">Message
        <textarea id="rentalNotifyMessage" class="rorc-input" rows="7">${escapeHtml(defaults.message)}</textarea>
      </label>

      <button class="admin-message-more rental-notify-preview-toggle" type="button">More Info</button>
      <div class="automation-preview-panel rental-notify-preview-panel" hidden>
        <iframe class="communication-preview-frame" title="Member message preview"></iframe>
        <details class="communication-preview-text">
          <summary>Plain text version</summary>
          <pre id="rentalNotifyPlainPreview"></pre>
        </details>
      </div>

      <label class="automation-confirm-checkbox">
        <input id="rentalNotifyConfirm" type="checkbox" />
        <span>Yes, send or schedule this member notification.</span>
      </label>

      <p id="rentalNotifyResult" class="auth-message" aria-live="polite"></p>

      <footer class="communication-preview-actions">
        <button class="communication-preview-cancel" type="button">Cancel</button>
        <button id="rentalNotifySubmit" class="communication-preview-confirm" type="button" disabled>Send / Schedule</button>
      </footer>
    </section>
  `;

  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKeydown);
  };
  const onKeydown = (event) => {
    if (event.key === "Escape") close();
  };

  let includeText = false;
  let includeEmail = true;
  let includeInApp = true;
  const textToggle = overlay.querySelector("#rentalNotifyText");
  const emailToggle = overlay.querySelector("#rentalNotifyEmail");
  const inAppToggle = overlay.querySelector("#rentalNotifyInApp");
  const confirm = overlay.querySelector("#rentalNotifyConfirm");
  const submit = overlay.querySelector("#rentalNotifySubmit");
  const customAt = overlay.querySelector("#rentalNotifyCustomAt");

  const renderChannels = () => {
    [
      [textToggle, includeText],
      [emailToggle, includeEmail],
      [inAppToggle, includeInApp]
    ].forEach(([button, active]) => {
      button?.classList.toggle("is-selected", active);
      button?.setAttribute("aria-pressed", String(active));
    });
    updateRentalNotifyPreview(overlay);
  };

  textToggle?.addEventListener("click", () => { includeText = !includeText; renderChannels(); });
  emailToggle?.addEventListener("click", () => { includeEmail = !includeEmail; renderChannels(); });
  inAppToggle?.addEventListener("click", () => { includeInApp = !includeInApp; renderChannels(); });

  confirm?.addEventListener("change", () => {
    if (submit) submit.disabled = !confirm.checked;
  });
  overlay.querySelector(".communication-preview-cancel")?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector(".rental-notify-dialog")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.addEventListener("keydown", onKeydown);

  const picker = overlay.querySelector("#rentalNotifyMembersPicker");
  picker?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openMultiMemberPicker(picker);
  });
  overlay.querySelector("#rentalNotifyMembers")?.addEventListener("change", () => setRentalNotifyRecipientSummary(overlay));
  setMultiMemberPickerValue("rentalNotifyMembers", []);

  overlay.querySelector("#rentalNotifySelectAll")?.addEventListener("click", () => {
    setMultiMemberPickerValue("rentalNotifyMembers", rentalNotifyEligibleMemberIds());
    setRentalNotifyRecipientSummary(overlay);
  });
  overlay.querySelector("#rentalNotifyClearMembers")?.addEventListener("click", () => {
    setMultiMemberPickerValue("rentalNotifyMembers", []);
    setRentalNotifyRecipientSummary(overlay);
  });

  overlay.querySelectorAll('input[name="rentalNotifyTiming"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (customAt) customAt.disabled = input.value !== "custom";
    });
  });
  customAt?.addEventListener("input", () => updateRentalNotifyPreview(overlay));
  overlay.querySelector("#rentalNotifyTitle")?.addEventListener("input", () => updateRentalNotifyPreview(overlay));
  overlay.querySelector("#rentalNotifyMessage")?.addEventListener("input", () => updateRentalNotifyPreview(overlay));

  overlay.querySelector(".rental-notify-preview-toggle")?.addEventListener("click", (event) => {
    const panel = overlay.querySelector(".rental-notify-preview-panel");
    if (!panel) return;
    const nextHidden = !panel.hidden;
    panel.hidden = nextHidden;
    event.currentTarget.textContent = nextHidden ? "More Info" : "Hide Info";
    updateRentalNotifyPreview(overlay);
  });

  submit?.addEventListener("click", async () => {
    const title = String(overlay.querySelector("#rentalNotifyTitle")?.value || "").trim();
    const message = String(overlay.querySelector("#rentalNotifyMessage")?.value || "").trim();
    const memberIds = selectedMemberIdsFromInput(overlay.querySelector("#rentalNotifyMembers"));
    const timing = selectedRentalNotifyTiming(overlay);

    if (!title) {
      setRentalNotifyResult(overlay, "Title is required.", "error");
      return;
    }
    if (!message) {
      setRentalNotifyResult(overlay, "Message is required.", "error");
      return;
    }
    if (!memberIds.length) {
      setRentalNotifyResult(overlay, "Select at least one member.", "error");
      return;
    }
    if (!includeText && !includeEmail && !includeInApp) {
      setRentalNotifyResult(overlay, "Select at least one delivery channel.", "error");
      return;
    }

    submit.disabled = true;
    setRentalNotifyResult(overlay, timing.isFuture ? "Scheduling..." : "Sending...");

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
        sendAt: timing.sendAt,
        scheduleLabel: timing.label,
        source: "rental",
        rentalRequestId: rental.id
      });

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
      try {
        await refreshMessageHistory();
      } catch (historyError) {
        console.warn("Could not refresh message history.", historyError);
      }

      setRentalNotifyResult(overlay, response.scheduled
        ? `Scheduled for ${formatFacilityShortDateTime(response.scheduledFor)}.`
        : `Sent. Texts: ${response.sentTextCount || 0}, Emails: ${response.sentEmailCount || 0}, In-App: ${response.sentInAppCount || 0}.`,
        "success");
      window.setTimeout(close, 900);
    } catch (error) {
      setRentalNotifyResult(overlay, error.message || "Could not send message.", "error");
      submit.disabled = false;
    }
  });

  renderChannels();
  setRentalNotifyRecipientSummary(overlay);
  updateRentalNotifyPreview(overlay);
}

function rentalNotifyEligibleMemberIds() {
  return memberPickerOptions("memberSignIn")
    .filter((member) => !["Kiosk Account", "RESTRICTED ACCOUNT", "Account Past Due NO ACCESS ALLOWED"].includes(canonicalAccountType(member.accountType)))
    .map((member) => member.id)
    .filter(Boolean);
}

function rentalNotifyDefaults(rental) {
  const eventName = rental.eventName || rental.eventType || "RORC event";
  const dateLabel = rental.eventDate
    ? new Date(`${rental.eventDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    : "Date TBD";
  const publicTime = rental.publicEventStartTime && rental.publicEventEndTime
    ? `${formatRentalNotifyTime(rental.publicEventStartTime)} - ${formatRentalNotifyTime(rental.publicEventEndTime)}`
    : rental.eventStartTime && rental.eventEndTime
      ? `${formatRentalNotifyTime(rental.eventStartTime)} - ${formatRentalNotifyTime(rental.eventEndTime)}`
      : "";
  const timeSentence = publicTime ? ` from ${publicTime}` : "";
  const message = [
    `RORC notice: ${eventName} is scheduled for ${dateLabel}${timeSentence}.`,
    "The gym may be unavailable during this rental. Please check the calendar before visiting."
  ].join("\n\n");
  const eventDateTime = rentalNotifyEventDateTime(rental);
  const customLocal = eventDateTime ? toFacilityDatetimeLocalValue(eventDateTime.toISOString()) : toFacilityDatetimeLocalValue(new Date().toISOString());

  return {
    title: `RORC Event Notice: ${eventName}`,
    message,
    dateLabel,
    customLocal
  };
}

function formatRentalNotifyTime(value) {
  const normalized = normalizeTimeFieldValue(value);
  if (!normalized) return "";
  const [hourValue, minuteValue = "00"] = normalized.split(":");
  const hour = Number(hourValue);
  if (!Number.isFinite(hour)) return normalized;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minuteValue.padStart(2, "0")} ${suffix}`;
}

function rentalNotifyEventDateTime(rental) {
  const date = String(rental?.eventDate || "").slice(0, 10);
  if (!date) return null;
  const time = normalizeTimeFieldValue(rental?.publicEventStartTime || rental?.eventStartTime || "09:00") || "09:00";
  const iso = facilityWallTimeToIso(date, time);
  const value = iso ? new Date(iso) : new Date(`${date}T${time}:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function rentalNotifyScheduleOptions(rental) {
  const eventDateTime = rentalNotifyEventDateTime(rental);
  const now = new Date();
  const options = [
    { key: "now", label: "Send now", value: new Date().toISOString(), checked: true }
  ];

  if (eventDateTime) {
    [
      ["week", "Schedule 1 week before event", 7],
      ["day", "Schedule 1 day before event", 1]
    ].forEach(([key, label, days]) => {
      const sendAt = new Date(eventDateTime.getTime() - (days * 24 * 60 * 60 * 1000));
      const disabled = sendAt.getTime() <= now.getTime() + 60000;
      options.push({
        key,
        label: disabled ? `${label} (past)` : `${label}: ${formatFacilityShortDateTime(sendAt.toISOString())}`,
        value: sendAt.toISOString(),
        disabled
      });
    });
  }

  options.push({
    key: "custom",
    label: "Custom time",
    value: "",
    disabled: false
  });

  return options;
}

function selectedRentalNotifyTiming(overlay) {
  const selected = overlay.querySelector('input[name="rentalNotifyTiming"]:checked');
  const key = selected?.value || "now";
  if (key === "custom") {
    const localValue = String(overlay.querySelector("#rentalNotifyCustomAt")?.value || "").trim();
    const iso = fromFacilityDatetimeLocalValue(localValue) || new Date().toISOString();
    return {
      sendAt: iso,
      isFuture: new Date(iso).getTime() > Date.now() + 60000,
      label: "Custom time"
    };
  }
  const sendAt = selected?.dataset.sendAt || new Date().toISOString();
  return {
    sendAt,
    isFuture: new Date(sendAt).getTime() > Date.now() + 60000,
    label: selected?.parentElement?.textContent?.trim() || "Send now"
  };
}

function setRentalNotifyRecipientSummary(overlay) {
  const summary = overlay.querySelector("#rentalNotifyRecipientSummary");
  const selectedMembers = selectedMemberIdsFromInput(overlay.querySelector("#rentalNotifyMembers"))
    .map((id) => findMember(id))
    .filter(Boolean);

  if (!summary) return;
  if (!selectedMembers.length) {
    summary.textContent = "No members selected.";
    return;
  }

  const phones = new Set(selectedMembers.map((member) => String(member.phoneNumber || "").trim()).filter(Boolean));
  const emails = new Set(selectedMembers.map((member) => String(member.emailAddress || "").trim().toLowerCase()).filter(Boolean));
  summary.textContent = `${selectedMembers.length} members selected · ${phones.size} phone numbers · ${emails.size} emails`;
}

function setRentalNotifyResult(overlay, message, tone = "default") {
  const result = overlay.querySelector("#rentalNotifyResult");
  if (!result) return;
  result.textContent = message;
  result.classList.toggle("is-error", tone === "error");
  result.classList.toggle("is-success", tone === "success");
}

function updateRentalNotifyPreview(overlay) {
  const title = String(overlay.querySelector("#rentalNotifyTitle")?.value || "").trim() || "RORC Event Notice";
  const message = String(overlay.querySelector("#rentalNotifyMessage")?.value || "").trim();
  const html = `
    <div style="font-family:Arial,sans-serif;background:#111;color:#f5f5f5;padding:28px;line-height:1.55;text-align:center;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#1b1b1b;border:1px solid #333;border-radius:14px;overflow:hidden;text-align:center;">
        <tr><td style="padding:28px 28px 16px;border-bottom:1px solid #333;text-align:center;"><h2 style="margin:0;color:#fff;font-size:32px;line-height:1.15;text-align:center;">${escapeHtml(title)}</h2></td></tr>
        <tr><td style="padding:20px 28px;text-align:center;"><p style="margin:0;color:#d1d5db;line-height:1.65;font-size:16px;text-align:center;">${escapeHtml(message).replaceAll("\n", "<br />")}</p></td></tr>
      </table>
    </div>
  `;
  const frame = overlay.querySelector(".communication-preview-frame");
  if (frame) frame.srcdoc = html;
  const plain = overlay.querySelector("#rentalNotifyPlainPreview");
  if (plain) plain.textContent = `${title}\n\n${message}`;
}

function showRentalEditForm(id, root) {
  const rental = rentalAllRequests.find((item) => item.id === id);
  const actionsEl = root.querySelector(`#rental-actions-${id}`);
  if (!rental || !actionsEl) return;

  actionsEl.innerHTML = buildRentalEditForm(rental);
  setRentalEditHoursState(root, id);
  syncRentalEditPublicEventState(root, id);
  bindRentalEditCalculations(root, id);

  root.querySelector(`#rental-edit-type-${id}`)?.addEventListener("change", () => {
    setRentalEditHoursState(root, id);
  });
  root.querySelector(`#rental-edit-public-toggle-${id}`)?.addEventListener("click", () => {
    const toggle = root.querySelector(`#rental-edit-public-toggle-${id}`);
    if (!toggle) return;
    const activate = toggle.dataset.publicActive !== "true";
    toggle.dataset.publicActive = activate ? "true" : "false";
    if (activate) {
      const publicStart = root.querySelector(`#rental-edit-public-start-${id}`);
      const publicEnd = root.querySelector(`#rental-edit-public-end-${id}`);
      if (publicStart && !publicStart.value) {
        publicStart.value = root.querySelector(`#rental-edit-start-${id}`)?.value || "";
      }
      if (publicEnd && !publicEnd.value) {
        publicEnd.value = root.querySelector(`#rental-edit-end-${id}`)?.value || "";
      }
    }
    syncRentalEditPublicEventState(root, id);
  });
  root.querySelector(`#rental-edit-cancel-${id}`)?.addEventListener("click", () => renderRentalPipeline(root));
  root.querySelector(`#rental-edit-save-${id}`)?.addEventListener("click", () => submitRentalEdit(id, root));
}

function buildRentalEditForm(r) {
  const id = escapeAttribute(r.id);
  const scheduleNote = r.rentalStatus === "confirmed"
    ? "Saving updates this rental and its linked calendar event."
    : "Saving updates this rental record.";
  const hasCleaningMaintenance = inferRentalCleaningMaintenance(r);
  const alcoholValue = r.alcohol === "Yes" ? "Yes" : "No";
  const totalDollars = String(Number((calculateRentalTotalCents({
    rentalType: r.rentalType,
    rentalHours: r.rentalHours,
    rentalAccessStart: r.eventStartTime,
    rentalAccessEnd: r.eventEndTime,
    isPrivateEvent: r.isPrivateEvent,
    specialAccessDiscount: r.specialAccessDiscount,
    addonCleaningMaintenance: hasCleaningMaintenance,
    addonTables: r.addonTables,
    addonChairs: r.addonChairs,
    addonTarp: r.addonTarp,
    addonHeater: r.addonHeater,
    addonAc: r.addonAc,
    addonEarlySetup: r.addonEarlySetup,
    addonEarlyDayRental: r.addonEarlyDayRental,
    addonLateCleanup: r.addonLateCleanup,
    addonLateDayRental: r.addonLateDayRental
  }) / 100).toFixed(2)));
  const hasLinkedCalendarEvent = Boolean(r.linkedCalendarEventId);
  const publicEventActive = hasLinkedCalendarEvent
    ? Boolean(r.calendarIsPublic)
    : Boolean(r.calendarIsPublic || (r.publicEventStartTime && r.publicEventEndTime));

  return `
    <div class="rental-action-form rental-edit-form">
      <div class="rental-edit-grid">
        <label class="rental-edit-field">Event Name
          <input id="rental-edit-event-name-${id}" class="rental-edit-input" type="text" value="${escapeAttribute(r.eventName || "")}" />
        </label>
        <label class="rental-edit-field">Rental Category
          <select id="rental-edit-event-type-${id}" class="rental-edit-input">
            ${renderRentalCategoryOptions(r.eventType)}
          </select>
        </label>
        <label class="rental-edit-field">Date
          <input id="rental-edit-date-${id}" class="rental-edit-input" type="date" value="${escapeAttribute(r.eventDate || "")}" />
        </label>
        <label class="rental-edit-field">Rental Access Start
          <input id="rental-edit-start-${id}" class="rental-edit-input" type="time" value="${escapeAttribute(rentalTimeInputValue(r.eventStartTime || "07:00"))}" />
        </label>
        <label class="rental-edit-field">Rental Access End
          <input id="rental-edit-end-${id}" class="rental-edit-input" type="time" value="${escapeAttribute(rentalTimeInputValue(r.eventEndTime || "21:00"))}" />
        </label>
        <div class="rental-edit-public-panel rental-edit-field-wide">
          <button id="rental-edit-public-toggle-${id}" class="rental-btn rental-btn-public" type="button" data-public-active="${publicEventActive ? "true" : "false"}"></button>
          <span id="rental-edit-public-help-${id}" class="rental-edit-public-help"></span>
        </div>
        <label class="rental-edit-field">Public Event Start
          <input id="rental-edit-public-start-${id}" class="rental-edit-input" type="time" value="${escapeAttribute(rentalTimeInputValue(r.publicEventStartTime || ""))}" />
        </label>
        <label class="rental-edit-field">Public Event End
          <input id="rental-edit-public-end-${id}" class="rental-edit-input" type="time" value="${escapeAttribute(rentalTimeInputValue(r.publicEventEndTime || ""))}" />
        </label>
        <label class="rental-edit-field">Contact Name
          <input id="rental-edit-contact-name-${id}" class="rental-edit-input" type="text" value="${escapeAttribute(r.contactName || "")}" />
        </label>
        <label class="rental-edit-field">Phone
          <input id="rental-edit-phone-${id}" class="rental-edit-input" type="tel" value="${escapeAttribute(r.contactPhone || "")}" />
        </label>
        <label class="rental-edit-field">Email
          <input id="rental-edit-email-${id}" class="rental-edit-input" type="email" value="${escapeAttribute(r.contactEmail || "")}" />
        </label>
        <label class="rental-edit-field rental-edit-field-wide">Mailing Address
          <input id="rental-edit-address-${id}" class="rental-edit-input" type="text" value="${escapeAttribute(r.contactAddress || "")}" />
        </label>
        <label class="rental-edit-field">Attendance
          <input id="rental-edit-attendance-${id}" class="rental-edit-input" type="number" min="1" inputmode="numeric" value="${escapeAttribute(r.estimatedAttendance || 1)}" />
        </label>
        <label class="rental-edit-field">Food or Drinks
          <select id="rental-edit-food-${id}" class="rental-edit-input">
            <option value="false"${r.foodOrDrinks ? "" : " selected"}>No</option>
            <option value="true"${r.foodOrDrinks ? " selected" : ""}>Yes</option>
          </select>
        </label>
        <label class="rental-edit-field">Private Event
          <select id="rental-edit-private-${id}" class="rental-edit-input">
            <option value="true"${r.isPrivateEvent === false ? "" : " selected"}>Yes - private rate</option>
            <option value="false"${r.isPrivateEvent === false ? " selected" : ""}>No - $5/hr non-private rate</option>
          </select>
        </label>
        <label class="rental-edit-field">Rental Type
          <select id="rental-edit-type-${id}" class="rental-edit-input">
            <option value="all_day"${r.rentalType !== "hourly" ? " selected" : ""}>All Day</option>
            <option value="hourly"${r.rentalType === "hourly" ? " selected" : ""}>Hourly</option>
          </select>
        </label>
        <label class="rental-edit-field">Billable Hours (auto)
          <input id="rental-edit-hours-${id}" class="rental-edit-input" type="number" min="0.01" max="9" step="0.01" inputmode="decimal" value="${escapeAttribute(r.rentalHours ? rentalHoursValue(r.rentalHours) : "")}" />
        </label>
        <label class="rental-edit-field">Alcohol
          <select id="rental-edit-alcohol-${id}" class="rental-edit-input">
            ${["No", "Yes"].map((value) => `<option value="${value}"${alcoholValue === value ? " selected" : ""}>${value}</option>`).join("")}
          </select>
        </label>
        <label class="rental-edit-field">Estimated Total
          <input id="rental-edit-total-${id}" class="rental-edit-input" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeAttribute(totalDollars)}" readonly aria-readonly="true" />
        </label>
      </div>

      <div class="rental-edit-checks">
        ${r.specialAccessDiscount ? `
          <label class="rental-edit-check">
            <input id="rental-edit-special-discount-${id}" type="checkbox" checked disabled />
            Special Access discount applied (20%)
          </label>
        ` : ""}
        ${rentalEditCheck(id, "cleaning", "Standard Maintenance Fee", hasCleaningMaintenance)}
        ${rentalEditCheck(id, "tables", "Tables", r.addonTables)}
        ${rentalEditCheck(id, "chairs", "Chairs", r.addonChairs)}
        ${rentalEditCheck(id, "tarp", "Tarp", r.addonTarp)}
        ${rentalEditCheck(id, "heater", "Heater", r.addonHeater)}
        ${rentalEditCheck(id, "ac", "AC ($2/hr)", r.addonAc)}
        ${rentalEditCheck(id, "early-setup", "Early setup", r.addonEarlySetup)}
        ${rentalEditCheck(id, "early-day", "Extra day early", r.addonEarlyDayRental)}
        ${rentalEditCheck(id, "late-cleanup", "Late cleanup", r.addonLateCleanup)}
        ${rentalEditCheck(id, "late-day", "Extra day late", r.addonLateDayRental)}
      </div>

      <label class="rental-edit-field">Admin Notes
        <textarea id="rental-edit-notes-${id}" class="rental-edit-input rental-action-textarea" rows="3">${escapeHtml(r.adminNotes || "")}</textarea>
      </label>

      <p class="rental-edit-help">${escapeHtml(scheduleNote)}</p>
      <p class="rental-action-error" id="rental-edit-err-${id}" hidden></p>

      <div class="rental-action-btns">
        <button class="rental-btn rental-btn-ghost" id="rental-edit-cancel-${id}" type="button">Back</button>
        <button class="rental-btn rental-btn-confirm" id="rental-edit-save-${id}" type="button">Save Booking</button>
      </div>
    </div>
  `;
}

function rentalEditCheck(id, key, label, checked) {
  return `
    <label class="rental-edit-check">
      <input id="rental-edit-${key}-${id}" type="checkbox"${checked ? " checked" : ""} />
      ${escapeHtml(label)}
    </label>
  `;
}

function renderRentalCategoryOptions(selected) {
  return ["Birthday Party", "Private Party", "Meeting", "Memorial Service", "Other"]
    .map((value) => `<option value="${escapeAttribute(value)}"${String(selected || "Other") === value ? " selected" : ""}>${escapeHtml(value)}</option>`)
    .join("");
}

function rentalTimeInputValue(value) {
  const match = String(value || "").match(/^(\d{2}:\d{2})/);
  return match ? match[1] : "";
}

function setRentalEditHoursState(root, id) {
  const typeEl = root.querySelector(`#rental-edit-type-${id}`);
  const hoursEl = root.querySelector(`#rental-edit-hours-${id}`);
  if (!typeEl || !hoursEl) return;
  const isHourly = typeEl.value === "hourly";
  const accessHours = normalizeRentalHours(rentalHoursBetween(
    root.querySelector(`#rental-edit-start-${id}`)?.value || "",
    root.querySelector(`#rental-edit-end-${id}`)?.value || "",
    Number(hoursEl.value || 1) || 1
  ));
  hoursEl.readOnly = true;
  hoursEl.disabled = !isHourly;
  if (isHourly) hoursEl.value = rentalHoursValue(accessHours);
  if (!isHourly) hoursEl.value = "";
  updateRentalEditTotal(root, id);
}

function syncRentalEditPublicEventState(root, id) {
  const toggle = root.querySelector(`#rental-edit-public-toggle-${id}`);
  const publicStart = root.querySelector(`#rental-edit-public-start-${id}`);
  const publicEnd = root.querySelector(`#rental-edit-public-end-${id}`);
  const help = root.querySelector(`#rental-edit-public-help-${id}`);
  if (!toggle || !publicStart || !publicEnd) return;

  const active = toggle.dataset.publicActive === "true";
  toggle.classList.toggle("is-active", active);
  toggle.textContent = active ? "Public Event On" : "+ Add Public Event";
  toggle.setAttribute("aria-pressed", active ? "true" : "false");
  publicStart.disabled = !active;
  publicEnd.disabled = !active;
  if (!active) {
    publicStart.value = "";
    publicEnd.value = "";
  }
  if (help) {
    help.textContent = active
      ? "This rental will show on the website calendar using the public event time below."
      : "Keep private, or add a public event time for the website calendar.";
  }
}

function rentalEditTotalValues(root, id) {
  const field = (name) => root.querySelector(`#rental-edit-${name}-${id}`);
  return {
    rentalType: field("type")?.value === "hourly" ? "hourly" : "all_day",
    rentalHours: normalizeRentalHours(field("hours")?.value || 1),
    rentalAccessStart: field("start")?.value || "",
    rentalAccessEnd: field("end")?.value || "",
    isPrivateEvent: field("private")?.value !== "false",
    specialAccessDiscount: Boolean(field("special-discount")?.checked),
    addonCleaningMaintenance: Boolean(field("cleaning")?.checked),
    addonTables: Boolean(field("tables")?.checked),
    addonChairs: Boolean(field("chairs")?.checked),
    addonTarp: Boolean(field("tarp")?.checked),
    addonHeater: Boolean(field("heater")?.checked),
    addonAc: Boolean(field("ac")?.checked),
    addonEarlySetup: Boolean(field("early-setup")?.checked),
    addonEarlyDayRental: Boolean(field("early-day")?.checked),
    addonLateCleanup: Boolean(field("late-cleanup")?.checked),
    addonLateDayRental: Boolean(field("late-day")?.checked)
  };
}

function calculateRentalEditTotalCents(root, id) {
  return calculateRentalTotalCents(rentalEditTotalValues(root, id));
}

function updateRentalEditTotal(root, id) {
  const totalEl = root.querySelector(`#rental-edit-total-${id}`);
  if (!totalEl) return;
  totalEl.value = String(Number((calculateRentalEditTotalCents(root, id) / 100).toFixed(2)));
}

function bindRentalEditCalculations(root, id) {
  const actionsEl = root.querySelector(`#rental-actions-${id}`);
  if (!actionsEl) return;
  actionsEl.querySelectorAll("input, select").forEach((field) => {
    const sync = () => {
      if (
        field.id === `rental-edit-start-${id}`
        || field.id === `rental-edit-end-${id}`
        || field.id === `rental-edit-type-${id}`
      ) {
        setRentalEditHoursState(root, id);
      } else {
        updateRentalEditTotal(root, id);
      }
    };
    field.addEventListener("input", sync);
    field.addEventListener("change", sync);
  });
  updateRentalEditTotal(root, id);
}

function collectRentalEditPayload(id, root) {
  const field = (name) => root.querySelector(`#rental-edit-${name}-${id}`);
  const rentalType = field("type")?.value === "hourly" ? "hourly" : "all_day";
  const accessStart = field("start")?.value || "07:00";
  const accessEnd = field("end")?.value || "21:00";
  const hours = normalizeRentalHours(rentalHoursBetween(accessStart, accessEnd, field("hours")?.value || 1));
  const calendarIsPublic = root.querySelector(`#rental-edit-public-toggle-${id}`)?.dataset.publicActive === "true";
  const publicStart = normalizeTimeFieldValue(field("public-start")?.value || "");
  const publicEnd = normalizeTimeFieldValue(field("public-end")?.value || "");

  return {
    event_name: field("event-name")?.value.trim() || "",
    event_type: field("event-type")?.value || "Other",
    event_date: field("date")?.value || "",
    event_start_time: accessStart,
    event_end_time: accessEnd,
    public_event_start_time: calendarIsPublic ? (publicStart || null) : null,
    public_event_end_time: calendarIsPublic ? (publicEnd || null) : null,
    calendar_is_public: calendarIsPublic,
    contact_name: field("contact-name")?.value.trim() || "",
    contact_phone: field("phone")?.value.trim() || "",
    contact_email: field("email")?.value.trim() || "",
    contact_address: field("address")?.value.trim() || "",
    estimated_attendance: Math.max(1, Number(field("attendance")?.value || 1) || 1),
    is_private_event: field("private")?.value !== "false",
    special_access_discount: Boolean(field("special-discount")?.checked),
    rental_type: rentalType,
    rental_hours: rentalType === "hourly" ? hours : null,
    alcohol: field("alcohol")?.value || "No",
    food_or_drinks: field("food")?.value === "true",
    addon_cleaning_maintenance: Boolean(field("cleaning")?.checked),
    addon_tables: Boolean(field("tables")?.checked),
    addon_chairs: Boolean(field("chairs")?.checked),
    addon_tarp: Boolean(field("tarp")?.checked),
    addon_heater: Boolean(field("heater")?.checked),
    addon_ac: Boolean(field("ac")?.checked),
    addon_early_setup: Boolean(field("early-setup")?.checked),
    addon_early_day_rental: Boolean(field("early-day")?.checked),
    addon_late_cleanup: Boolean(field("late-cleanup")?.checked),
    addon_late_day_rental: Boolean(field("late-day")?.checked),
    estimated_total_cents: calculateRentalEditTotalCents(root, id),
    adminNotes: field("notes")?.value.trim() || ""
  };
}

function applyRentalEditToCache(id, payload, updatedRequest) {
  const idx = rentalAllRequests.findIndex((r) => r.id === id);
  if (idx === -1) return;
  if (updatedRequest) {
    rentalAllRequests[idx] = {
      ...rentalAllRequests[idx],
      ...updatedRequest,
      isPrivateEvent: payload.is_private_event,
      specialAccessDiscount: payload.special_access_discount,
      addonCleaningMaintenance: payload.addon_cleaning_maintenance,
      addonAc: payload.addon_ac
    };
    return;
  }

  rentalAllRequests[idx] = {
    ...rentalAllRequests[idx],
    eventName: payload.event_name,
    eventType: payload.event_type,
    eventDate: payload.event_date,
    eventStartTime: payload.event_start_time,
    eventEndTime: payload.event_end_time,
    publicEventStartTime: payload.public_event_start_time,
    publicEventEndTime: payload.public_event_end_time,
    calendarIsPublic: payload.calendar_is_public,
    contactName: payload.contact_name,
    contactPhone: payload.contact_phone,
    contactEmail: payload.contact_email,
    contactAddress: payload.contact_address,
    estimatedAttendance: payload.estimated_attendance,
    rentalType: payload.rental_type,
    rentalHours: payload.rental_hours,
    isPrivateEvent: payload.is_private_event,
    specialAccessDiscount: payload.special_access_discount,
    addonCleaningMaintenance: payload.addon_cleaning_maintenance,
    alcohol: payload.alcohol,
    foodOrDrinks: payload.food_or_drinks,
    addonTables: payload.addon_tables,
    addonChairs: payload.addon_chairs,
    addonTarp: payload.addon_tarp,
    addonHeater: payload.addon_heater,
    addonAc: payload.addon_ac,
    addonEarlySetup: payload.addon_early_setup,
    addonEarlyDayRental: payload.addon_early_day_rental,
    addonLateCleanup: payload.addon_late_cleanup,
    addonLateDayRental: payload.addon_late_day_rental,
    estimatedTotalCents: payload.estimated_total_cents,
    adminNotes: payload.adminNotes,
    reviewedAt: new Date().toISOString()
  };
}

async function submitRentalEdit(id, root) {
  const saveBtn = root.querySelector(`#rental-edit-save-${id}`);
  const errEl = root.querySelector(`#rental-edit-err-${id}`);
  const payload = collectRentalEditPayload(id, root);

  if (!payload.event_name) {
    if (errEl) { errEl.textContent = "Event name is required."; errEl.hidden = false; }
    return;
  }
  if (!payload.event_date) {
    if (errEl) { errEl.textContent = "Date is required."; errEl.hidden = false; }
    return;
  }
  const rentalStartMinutes = minutesFromTimeValue(normalizeTimeFieldValue(payload.event_start_time));
  const rentalEndMinutes = minutesFromTimeValue(normalizeTimeFieldValue(payload.event_end_time));
  if (rentalStartMinutes === null || rentalEndMinutes === null || rentalEndMinutes <= rentalStartMinutes) {
    if (errEl) { errEl.textContent = "Rental access end must be after rental access start."; errEl.hidden = false; }
    return;
  }
  if (payload.calendar_is_public && (!payload.public_event_start_time || !payload.public_event_end_time)) {
    if (errEl) { errEl.textContent = "Public event start/end are required when Public Event is on."; errEl.hidden = false; }
    return;
  }
  if (Boolean(payload.public_event_start_time) !== Boolean(payload.public_event_end_time)) {
    if (errEl) { errEl.textContent = "Public event start/end must both be filled or both be blank."; errEl.hidden = false; }
    return;
  }
  if (payload.public_event_start_time && payload.public_event_end_time) {
    const publicStartMinutes = minutesFromTimeValue(payload.public_event_start_time);
    const publicEndMinutes = minutesFromTimeValue(payload.public_event_end_time);
    if (publicStartMinutes === null || publicEndMinutes === null || publicEndMinutes <= publicStartMinutes) {
      if (errEl) { errEl.textContent = "Public event end must be after public event start."; errEl.hidden = false; }
      return;
    }
  }

  try {
    if (errEl) errEl.hidden = true;
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving..."; }

    const token = currentAuthSession?.access_token || "";
    const res = await fetch("/api/rental-reviews", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...payload })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) throw new Error(body.error || "Could not update rental.");

    rentalAutomationNotice = Array.isArray(body.automationWarnings) && body.automationWarnings.length
      ? `Saved, but automation needs attention: ${body.automationWarnings.join(", ")}. Check Vercel logs for details.`
      : "";
    applyRentalEditToCache(id, payload, body.request);
    highlightRentalId = id;
    renderRentalPipeline(root);
  } catch (err) {
    if (errEl) { errEl.textContent = err.message || "Could not update rental."; errEl.hidden = false; }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Try Again"; }
  }
}

function handleRentalAction(btn, root) {
  const action = btn.dataset.rentalAction;
  const id     = btn.dataset.rentalId;
  const actionsEl = root.querySelector(`#rental-actions-${id}`);
  if (!actionsEl) return;

  if (action === "delete") {
    void deleteRentalRequest(id, root);
    return;
  }

  if (action === "pending_review") {
    submitRentalStatusChange(id, "pending_review", null, root);
    return;
  }

  const isDecline = action === "decline";
  const isCancel  = action === "cancel";
  const rental = rentalAllRequests.find((item) => item.id === id);
  const hasEmail = Boolean(String(rental?.contactEmail || "").trim());

  actionsEl.innerHTML = `
      <div class="rental-action-form">
        <div class="rental-action-label">
          <span class="admin-message-label-row">
            <span>Description ${isDecline ? "<span class='rental-action-required'>(required)</span>" : ""}</span>
            ${hasEmail ? "" : "<span class=\"admin-delivery-notice is-muted\">No email address on file</span>"}
          </span>
          <textarea class="rental-action-textarea" id="rental-notes-${escapeAttribute(id)}" rows="3"
            placeholder="${isDecline ? "Explain why this request is being declined..." : isCancel ? "Any notes for the cancellation..." : "Any confirmation details..."}"></textarea>
        </div>
        <div class="rental-action-btns">
          <button class="rental-btn rental-btn-ghost" id="rental-cancel-form-${escapeAttribute(id)}" type="button">Back</button>
          <button class="rental-btn ${isDecline || isCancel ? "rental-btn-decline" : "rental-btn-confirm"}"
                  id="rental-submit-${escapeAttribute(id)}" type="button">
            ${isDecline ? "Decline Booking" : isCancel ? "Cancel Booking" : "Confirm Booking"}
          </button>
        </div>
        <p class="rental-action-error" id="rental-action-err-${escapeAttribute(id)}" hidden></p>
    </div>
  `;

  root.querySelector(`#rental-cancel-form-${id}`).addEventListener("click", () => renderRentalPipeline(root));

  root.querySelector(`#rental-submit-${id}`).addEventListener("click", async () => {
    const notes   = root.querySelector(`#rental-notes-${id}`)?.value.trim() || "";
    const errEl   = root.querySelector(`#rental-action-err-${id}`);
    if (isDecline && !notes) {
      errEl.textContent = "A reason is required when declining.";
      errEl.hidden = false;
      return;
    }

    const statusMap = { confirm: "confirmed", decline: "rejected", cancel: "canceled" };
    await submitRentalStatusChange(id, statusMap[action], notes || null, root);
  });
}

async function deleteRentalRequest(id, root) {
  const rental = rentalAllRequests.find((item) => item.id === id);
  if (!rental) return;

  const deleteRentalConfirmed = await openLinkedDeleteDialog({
    title: "Delete rental request?",
    message: "This will permanently delete the rental request from the rentals page.",
    confirmLabel: "Delete",
    cancelLabel: "Cancel"
  });
  if (!deleteRentalConfirmed) return;

  const linkedEventId = await fetchLinkedCalendarEventIdForRental(id);
  let deleteCalendarToo = false;
  if (linkedEventId) {
    deleteCalendarToo = await openLinkedDeleteDialog({
      title: "Delete linked calendar event too?",
      message: "Do you want to delete this booking from the calendar as well?",
      confirmLabel: "Yes",
      cancelLabel: "No"
    });
  }

  try {
    const token = currentAuthSession?.access_token || "";
    if (!token) throw new Error("Please sign in again before deleting.");

    const res = await fetch("/api/rental-reviews", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id, deleteLinkedEvent: deleteCalendarToo })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) throw new Error(body.error || "Could not delete rental request.");

    rentalAllRequests = rentalAllRequests.filter((item) => item.id !== id);
    rentalReviewsPendingCount = rentalAllRequests.filter(
      (r) => r.rentalStatus === "submitted" || r.rentalStatus === "pending_review"
    ).length;
    updateRentalReviewsBadge();
    renderRentalPipeline(root);
  } catch (err) {
    rentalAutomationNotice = err.message || "Could not delete rental request.";
    renderRentalPipeline(root);
  }
}

async function submitRentalStatusChange(id, status, notes, root) {
  const submitBtn = root.querySelector(`#rental-submit-${id}`);
  const errEl     = root.querySelector(`#rental-action-err-${id}`);

  try {
    if (["confirmed", "rejected", "canceled"].includes(status)) {
      const actionLabel = status === "confirmed" ? "Confirm Booking"
        : status === "rejected" ? "Decline Booking"
          : "Cancel Booking";
      const automationConfirmed = await confirmAutomatedEmailBeforeSave({
        type: "rental_review",
        id,
        status,
        adminNotes: notes || ""
      }, {
        title: `${actionLabel}?`,
        message: "This admin action has an automated email scheduled for the rental contact.",
        confirmLabel: `${actionLabel} & Send Email`
      });
      if (!automationConfirmed) return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }

    const token = currentAuthSession?.access_token || "";
    const payload = { id, status };
    if (typeof notes === "string") payload.adminNotes = notes;

    const res   = await fetch("/api/rental-reviews", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) throw new Error(body.error || "Could not update request.");

    rentalAutomationNotice = Array.isArray(body.automationWarnings) && body.automationWarnings.length
      ? `Saved, but automation needs attention: ${body.automationWarnings.join(", ")}. Check Vercel logs for details.`
      : "";

    // Update local cache so filter re-render is instant
    const idx = rentalAllRequests.findIndex((r) => r.id === id);
    if (idx !== -1) {
      rentalAllRequests[idx].rentalStatus = status;
      rentalAllRequests[idx].adminNotes   = notes ?? rentalAllRequests[idx].adminNotes;
      rentalAllRequests[idx].reviewedAt   = new Date().toISOString();
    }

    rentalReviewsPendingCount = rentalAllRequests.filter(
      (r) => r.rentalStatus === "submitted" || r.rentalStatus === "pending_review"
    ).length;
    updateRentalReviewsBadge();
    renderRentalPipeline(root);
  } catch (err) {
    if (errEl) { errEl.textContent = err.message || "Could not update request."; errEl.hidden = false; }
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Try Again"; }
  }
}

// ─────────────────────────────────────────────
// Calendar
// ─────────────────────────────────────────────

function facilityDateParts(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === "24" ? "00" : parts.hour,
    minute: parts.minute
  };
}

function facilityDateKey(dateLike) {
  const parts = facilityDateParts(dateLike);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : "";
}

function calendarTimestampDateKey(value, allDay = false) {
  const raw = String(value || "");
  if (allDay && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    return raw.slice(0, 10);
  }
  return facilityDateKey(raw);
}

function facilityTimeInputValue(value) {
  const raw = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    return raw.slice(11, 16);
  }
  const parts = facilityDateParts(raw);
  return parts ? `${parts.hour}:${parts.minute}` : "";
}

function facilityTimeRange(startAt, endAt) {
  const start = facilityTimeInputValue(startAt);
  const end = facilityTimeInputValue(endAt);
  return start && end ? `${start} – ${end}` : "";
}

function getFacilityTimeZoneOffsetMs(date) {
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    timeZoneName: "shortOffset"
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value || "GMT";
  const match = zoneName.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  return sign * ((hours * 60) + minutes) * 60000;
}

function facilityWallTimeToIso(dateStr, timeStr = "00:00") {
  const [year, month, day] = String(dateStr || "").split("-").map(Number);
  const [hour, minute] = String(timeStr || "00:00").split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return "";

  const wallTime = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utcTime = wallTime;
  for (let i = 0; i < 3; i += 1) {
    utcTime = wallTime - getFacilityTimeZoneOffsetMs(new Date(utcTime));
  }
  return new Date(utcTime).toISOString();
}

const EVENT_COLORS = {
  rental:        "#ef3b36",
  maintenance:   "#f59e0b",
  rorc:          "#9ca3af"
};

const EVENT_LABELS = {
  rental:        "Rental",
  maintenance:   "Maintenance",
  rorc:          "RORC"
};

function normalizeEventTypeForUi(type) {
  const raw = String(type || "").trim();
  if (Object.prototype.hasOwnProperty.call(EVENT_LABELS, raw)) return raw;
  if (raw === "open_gym" || raw === "private_event" || raw === "public_event" || raw === "general") {
    return "rorc";
  }
  return "rorc";
}

let calendarEvents = [];
const initialFacilityDate = facilityDateParts(new Date());
let calendarYear = Number(initialFacilityDate?.year || new Date().getFullYear());
let calendarMonth = Number(initialFacilityDate?.month || (new Date().getMonth() + 1)) - 1;
let pendingCalendarRentalCreate = false;
let pendingCalendarMemberCreate = false;
let pendingCalendarMemberEditId = "";
let calendarEventRequests = [];
let calendarRequestNotice = "";
let hasOwnedCalendarEvents = false;
const DEFAULT_FACILITY_HOURS = {
  start: "07:00",
  end: "21:00"
};
let facilityHours = { ...DEFAULT_FACILITY_HOURS };
let facilityHourOverrides = {};
let calendarFacilityBlocks = [];

function normalizeHourValue(raw, fallback) {
  const match = String(raw || "").match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  return match ? `${match[1]}:${match[2]}` : fallback;
}

function normalizeFacilityHours(settings) {
  return {
    start: normalizeHourValue(settings?.start ?? settings?.facility_start, DEFAULT_FACILITY_HOURS.start),
    end: normalizeHourValue(settings?.end ?? settings?.facility_end, DEFAULT_FACILITY_HOURS.end)
  };
}

function normalizeFacilityHourOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.entries(raw).forEach(([dateKey, value]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !value || typeof value !== "object") return;
    if (value.closed === true) {
      out[dateKey] = { closed: true };
      return;
    }
    const start = normalizeHourValue(value.start ?? value.facility_start, "");
    const end = normalizeHourValue(value.end ?? value.facility_end, "");
    if (start && end) out[dateKey] = { start, end };
  });
  return out;
}

function calendarSettingsPayload() {
  return {
    facility_start: facilityHours.start,
    facility_end: facilityHours.end,
    overrides: facilityHourOverrides
  };
}

function formatHourLabel(timeValue) {
  const [hourStr, minuteStr] = String(timeValue || "").split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return String(timeValue || "");
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 || 12;
  const mm = String(minute).padStart(2, "0");
  return `${h12}:${mm} ${period}`;
}

function minutesFromTimeValue(timeValue) {
  const match = String(timeValue || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return (Number(match[1]) * 60) + Number(match[2]);
}

function timeValueFromMinutes(totalMinutes) {
  const safe = Math.max(0, Math.min(1439, Number(totalMinutes) || 0));
  const hour = Math.floor(safe / 60);
  const minute = safe % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function facilityHoursForDate(dateIso) {
  const override = facilityHourOverrides[dateIso];
  if (override?.closed) return { closed: true };
  if (override?.start && override?.end) return normalizeFacilityHours(override);
  return { ...facilityHours };
}

function blockingEventIntervalForDate(ev, dateIso) {
  if (!["rental", "maintenance"].includes(normalizeEventTypeForUi(ev.eventType))) return null;
  if (String(ev.status || "confirmed") !== "confirmed") return null;
  const blockStartAt = ev.eventType === "rental" && ev.rentalAccessStartAt ? ev.rentalAccessStartAt : ev.startAt;
  const blockEndAt = ev.eventType === "rental" && ev.rentalAccessEndAt ? ev.rentalAccessEndAt : ev.endAt;
  if (calendarTimestampDateKey(blockStartAt, ev.allDay) !== dateIso) return null;
  if (ev.allDay) return { start: 0, end: 1440 };
  const start = minutesFromTimeValue(facilityTimeInputValue(blockStartAt));
  const end = minutesFromTimeValue(facilityTimeInputValue(blockEndAt));
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

function facilityOpenWindowsForDate(dateIso, events = calendarEvents) {
  const base = facilityHoursForDate(dateIso);
  if (base.closed) return [];
  const start = minutesFromTimeValue(base.start);
  const end = minutesFromTimeValue(base.end);
  if (start === null || end === null || end <= start) return [];

  let windows = [{ start, end }];
  const blockingEvents = events === calendarEvents
    ? [...(events || []), ...calendarFacilityBlocks]
    : (events || []);
  blockingEvents
    .map((ev) => blockingEventIntervalForDate(ev, dateIso))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)
    .forEach((block) => {
      const next = [];
      windows.forEach((window) => {
        const blockStart = Math.max(block.start, window.start);
        const blockEnd = Math.min(block.end, window.end);
        if (blockEnd <= window.start || blockStart >= window.end) {
          next.push(window);
          return;
        }
        if (blockStart > window.start) next.push({ start: window.start, end: blockStart });
        if (blockEnd < window.end) next.push({ start: blockEnd, end: window.end });
      });
      windows = next;
    });

  return windows;
}

function formatFacilityWindow(window) {
  return `${formatHourLabel(timeValueFromMinutes(window.start))} - ${formatHourLabel(timeValueFromMinutes(window.end))}`;
}

function facilityHoursDisplayForDate(dateIso) {
  const windows = facilityOpenWindowsForDate(dateIso);
  return windows.length ? windows.map(formatFacilityWindow).join(", ") : "Closed";
}

function currentMemberCalendarSnapshot() {
  const member = findMember(appUserSession.memberId) || {};
  return {
    memberName: member.memberName || appUserSession.memberName || "",
    accountType: canonicalAccountType(member.accountType || appUserSession.accountType),
    phoneNumber: member.phoneNumber || "",
    emailAddress: member.emailAddress || appState.currentUserEmail || "",
    mailingAddress: member.mailingAddress || ""
  };
}

function calendarOwnerIdFromCreatedBy(createdBy) {
  const match = String(createdBy || "").match(/^(?:member|special_access):([a-zA-Z0-9_-]+)/);
  return match ? match[1] : "";
}

function isOwnedCalendarEvent(event) {
  return calendarOwnerIdFromCreatedBy(event?.createdBy) === appUserSession.memberId;
}

function canEditCalendarEventForSession(event) {
  if (!event || event.pendingRequestId) return false;
  if (isAccountManager(appUserSession)) return true;
  if (event.rentalRequestId) return false;
  return canRequestCalendarEventChanges(appUserSession) && isOwnedCalendarEvent(event);
}

function requestPayloadDateKey(payload) {
  return calendarTimestampDateKey(payload?.start_at || payload?.startAt, Boolean(payload?.all_day ?? payload?.allDay));
}

function pendingEventFromRequest(request) {
  const payload = request?.eventPayload || {};
  const createdBy = `pending_request:${request.id}${payload.detail_only ? ":detail" : ""}`;
  return {
    id: `request:${request.id}`,
    title: payload.title || "Pending event",
    description: payload.description || "",
    eventType: normalizeEventTypeForUi(payload.event_type || payload.eventType || "rorc"),
    startAt: payload.start_at || payload.startAt || "",
    endAt: payload.end_at || payload.endAt || "",
    allDay: Boolean(payload.all_day ?? payload.allDay),
    isPublic: true,
    status: "pending",
    rentalRequestId: "",
    rentalAccessStartAt: "",
    rentalAccessEndAt: "",
    createdBy,
    detailOnly: Boolean(payload.detail_only ?? payload.detailOnly),
    isRecurring: false,
    recurringSeriesId: "",
    pendingRequestId: request.id,
    pendingRequestType: request.requestType,
    pendingStatus: request.status
  };
}

function calendarEventsForCurrentViewer() {
  return calendarEvents;
}

async function fetchCalendarEventRequests({ includeEvents = false, mineOnly = false } = {}) {
  const token = currentAuthSession?.access_token || "";
  if (!token) throw new Error("Please sign in again.");
  const params = new URLSearchParams();
  if (includeEvents) params.set("includeEvents", "true");
  if (mineOnly) params.set("scope", "mine");
  const query = params.toString();
  const url = `/api/calendar-event-requests${query ? `?${query}` : ""}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not load calendar requests.");
  }
  return body;
}

function updateOwnedCalendarEventAvailability(events = [], requests = []) {
  hasOwnedCalendarEvents = canViewOwnedCalendarEvents(appUserSession)
    && ((Array.isArray(events) && events.length > 0) || (Array.isArray(requests) && requests.length > 0));
  updateNavigationVisibility();
}

async function refreshOwnedCalendarEventAvailability() {
  if (!canViewOwnedCalendarEvents(appUserSession)) {
    updateOwnedCalendarEventAvailability([], []);
    return;
  }

  try {
    const body = await fetchCalendarEventRequests({ includeEvents: true, mineOnly: true });
    updateOwnedCalendarEventAvailability(body.events || [], body.requests || []);
  } catch (error) {
    console.warn("Could not refresh owned calendar events.", error);
    updateOwnedCalendarEventAvailability([], []);
  }
}

function requestTypeLabel(requestType) {
  if (requestType === "create") return "New event";
  if (requestType === "update") return "Edit request";
  if (requestType === "delete") return "Delete request";
  return "Request";
}

function requestStatusLabel(status) {
  if (status === "pending") return "Pending Approval";
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  if (status === "canceled") return "Canceled";
  return status || "Pending";
}

function calendarRequestDateLabel(request) {
  const payload = request?.eventPayload || {};
  const dateKey = requestPayloadDateKey(payload);
  if (!dateKey) return "No date";
  const dateLabel = new Date(`${dateKey}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  if (request.requestType === "delete") return dateLabel;
  const timeLabel = payload.all_day ? "All Day" : facilityTimeRange(payload.start_at, payload.end_at);
  return `${dateLabel}${timeLabel ? ` · ${timeLabel}` : ""}`;
}

function renderCalendarRequestsAdminPanel() {
  if (!isAccountManager(appUserSession)) return "";
  const pending = calendarEventRequests.filter((request) => request.status === "pending");
  if (!pending.length) return "";

  return `
    <section class="calendar-request-panel" aria-label="Pending calendar requests">
      <div class="calendar-request-panel-head">
        <span>Member Event Requests</span>
        <strong>${pending.length}</strong>
      </div>
      <div class="calendar-request-list">
        ${pending.map((request) => {
          const payload = request.eventPayload || {};
          const requester = request.requester || {};
          return `
            <article class="calendar-request-card">
              <div>
                <span class="calendar-request-kicker">${escapeHtml(requestTypeLabel(request.requestType))}</span>
                <h3>${escapeHtml(payload.title || "Calendar event")}</h3>
                <p>${escapeHtml(calendarRequestDateLabel(request))}</p>
                <p>${escapeHtml(requester.memberName || "Member account")}${requester.emailAddress ? ` · ${escapeHtml(requester.emailAddress)}` : ""}${requester.phoneNumber ? ` · ${escapeHtml(requester.phoneNumber)}` : ""}</p>
              </div>
              <div class="calendar-request-actions">
                <button class="app-admin-btn app-admin-btn-secondary" type="button" data-calendar-request-action="reject" data-request-id="${escapeAttribute(request.id)}">Reject</button>
                <button class="app-admin-btn app-admin-btn-primary" type="button" data-calendar-request-action="approve" data-request-id="${escapeAttribute(request.id)}">Approve</button>
              </div>
            </article>`;
        }).join("")}
      </div>
    </section>
  `;
}

function renderCalendarRequestNotice() {
  if (!calendarRequestNotice) return "";
  const notice = calendarRequestNotice;
  calendarRequestNotice = "";
  return `<div class="calendar-request-notice">${escapeHtml(notice)}</div>`;
}

async function reviewCalendarEventRequest(root, requestId, action) {
  if (!isAccountManager(appUserSession) || !requestId || !["approve", "reject"].includes(action)) return;
  const request = calendarEventRequests.find((item) => item.id === requestId);
  const confirmed = await openLinkedDeleteDialog({
    title: `${action === "approve" ? "Approve" : "Reject"} calendar request?`,
    message: action === "approve"
      ? `This will ${request?.requestType === "delete" ? "commit the delete from" : "write the change to"} the public calendar.`
      : "This keeps the public calendar unchanged and marks the request rejected.",
    confirmLabel: action === "approve" ? "Approve" : "Reject",
    cancelLabel: "Cancel"
  });
  if (!confirmed) return;

  try {
    const token = currentAuthSession?.access_token || "";
    const response = await fetch("/api/calendar-event-requests", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: requestId, action })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) {
      throw new Error(body.error || "Could not review request.");
    }
    calendarRequestNotice = action === "approve" ? "Calendar request approved." : "Calendar request rejected.";
    await renderCalendarPage();
  } catch (error) {
    root.insertAdjacentHTML("afterbegin", `<div class="feedback-error">${escapeHtml(error.message || "Could not review request.")}</div>`);
  }
}

async function renderMyEventsPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;
  root.classList.add("my-events-page");
  deferContentUntilReady(root);

  if (!canViewMyEventsRoute(appUserSession)) {
    revealReadyContent(root);
    root.innerHTML = `<p class="feedback-empty">My Events appears after your account has an owned or pending event.</p>`;
    return;
  }

  try {
    const body = await fetchCalendarEventRequests({ includeEvents: true, mineOnly: true });
    calendarEventRequests = body.requests || [];
    updateOwnedCalendarEventAvailability(body.events || [], calendarEventRequests);
    renderMyEventsView(root, body.events || [], calendarEventRequests);
  } catch (error) {
    revealReadyContent(root);
    root.innerHTML = `<p class="feedback-empty">${escapeHtml(error.message || "Could not load your events.")}</p>`;
  }
}

function renderMyEventsView(root, events, requests) {
  revealReadyContent(root);
  const canRequestEvents = canRequestCalendarEventChanges(appUserSession);
  const pendingRequests = (requests || []).filter((request) => request.status === "pending");
  const hiddenTargetIds = new Set(
    pendingRequests
      .filter((request) => request.targetEventId && ["update", "delete"].includes(request.requestType))
      .map((request) => request.targetEventId)
  );
  const visibleEvents = (events || [])
    .filter((event) => !hiddenTargetIds.has(event.id))
    .sort((a, b) => String(a.startAt || "").localeCompare(String(b.startAt || "")));

  root.innerHTML = `
    <section class="my-events-hero">
      <div>
        <span class="calendar-request-kicker">Account Events</span>
        <h2>My Events</h2>
        <p>${canRequestEvents
          ? "Add events to the calendar and track approval status here. New events, edits, and deletes stay pending until an admin approves them."
          : "View rental events connected to your account. Rental booking changes are requested from the member dashboard."}</p>
      </div>
      ${canRequestEvents ? `<button class="app-admin-btn app-admin-btn-primary" id="myEventsNewRequest" type="button">+ Add Event</button>` : ""}
    </section>

    <section class="my-events-section">
      <h3>Pending Approval</h3>
      ${pendingRequests.length
        ? `<div class="my-events-list">${pendingRequests.map(renderMyEventsRequestCard).join("")}</div>`
        : `<p class="feedback-empty">No pending event requests.</p>`}
    </section>

    <section class="my-events-section">
      <h3>Approved Events</h3>
      ${visibleEvents.length
        ? `<div class="my-events-list">${visibleEvents.map(renderMyEventsApprovedEventCard).join("")}</div>`
        : `<p class="feedback-empty">No approved events yet.</p>`}
    </section>
  `;

  root.querySelector("#myEventsNewRequest")?.addEventListener("click", () => {
    pendingCalendarMemberCreate = true;
    navigateTo("calendar");
  });

  root.querySelectorAll("[data-my-event-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      pendingCalendarMemberEditId = button.dataset.myEventEdit || "";
      navigateTo("calendar");
    });
  });

  root.querySelectorAll("[data-my-event-delete]").forEach((button) => {
    button.addEventListener("click", () => submitMyEventsDeleteRequest(root, button.dataset.myEventDelete || ""));
  });
}

function renderMyEventsRequestCard(request) {
  const payload = request.eventPayload || {};
  return `
    <article class="my-events-card">
      <div>
        <span class="calendar-request-kicker">${escapeHtml(requestTypeLabel(request.requestType))}</span>
        <h4>${escapeHtml(payload.title || "Calendar event")}</h4>
        <p>${escapeHtml(calendarRequestDateLabel(request))}</p>
        <span class="my-events-status">${escapeHtml(requestStatusLabel(request.status))}</span>
      </div>
    </article>
  `;
}

function renderMyEventsApprovedEventCard(event) {
  const canEdit = canEditCalendarEventForSession(event);
  const manageBookingUrl = event.rentalRequestId
    ? `/member-dashboard/?booking=${encodeURIComponent(event.rentalRequestId)}`
    : "";
  return `
    <article class="my-events-card">
      <div>
        <span class="calendar-request-kicker">Approved</span>
        <h4>${escapeHtml(event.title || "Calendar event")}</h4>
        <p>${escapeHtml(calendarEventDateLabel(event))}</p>
        ${canEdit ? "" : `<span class="my-events-status">Managed by rental/admin</span>`}
      </div>
      ${canEdit ? `
        <div class="my-events-actions">
          <button class="app-admin-btn app-admin-btn-secondary" type="button" data-my-event-edit="${escapeAttribute(event.id)}">Edit</button>
          <button class="app-admin-btn app-admin-btn-danger" type="button" data-my-event-delete="${escapeAttribute(event.id)}">Request Delete</button>
        </div>
      ` : manageBookingUrl ? `
        <div class="my-events-actions">
          <a class="app-admin-btn app-admin-btn-secondary" href="${escapeAttribute(manageBookingUrl)}">Manage Booking</a>
        </div>
      ` : ""}
    </article>
  `;
}

function calendarEventDateLabel(event) {
  const dateKey = calendarTimestampDateKey(event?.startAt, Boolean(event?.allDay));
  if (!dateKey) return "No date";
  const dateLabel = new Date(`${dateKey}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${dateLabel}${event?.allDay ? " · All Day" : ` · ${facilityTimeRange(event?.startAt, event?.endAt)}`}`;
}

async function submitMyEventsDeleteRequest(root, eventId) {
  const event = (eventId && Array.isArray(calendarEvents)) ? calendarEvents.find((item) => item.id === eventId) : null;
  const confirmed = await openLinkedDeleteDialog({
    title: "Request event delete?",
    message: "This will hide the event from your calendar while it waits for admin approval.",
    confirmLabel: "Submit Delete",
    cancelLabel: "Cancel"
  });
  if (!confirmed) return;

  try {
    const token = currentAuthSession?.access_token || "";
    const response = await fetch("/api/calendar-event-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ requestType: "delete", targetEventId: eventId || event?.id })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error || "Could not submit delete request.");
    calendarRequestNotice = "Event delete submitted for approval.";
    hasOwnedCalendarEvents = true;
    updateNavigationVisibility();
    await renderMyEventsPage();
  } catch (error) {
    root.insertAdjacentHTML("afterbegin", `<div class="feedback-error">${escapeHtml(error.message || "Could not submit delete request.")}</div>`);
  }
}

async function loadFacilityHoursFromServer() {
  try {
    const settings = await loadAutomationSettings();
    const calendarSettings = settings?.calendar_settings || {};
    return {
      hours: normalizeFacilityHours(calendarSettings),
      overrides: normalizeFacilityHourOverrides(calendarSettings.overrides || {})
    };
  } catch {
    return { hours: { ...DEFAULT_FACILITY_HOURS }, overrides: {} };
  }
}

async function saveFacilityHoursToServer(hours) {
  const normalized = normalizeFacilityHours(hours);
  facilityHours = normalized;
  await saveAutomationSettings({
    calendar_settings: calendarSettingsPayload()
  });
}

async function saveFacilityHourOverrideToServer(dateIso, override) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso || ""))) {
    throw new Error("Valid date is required.");
  }
  if (override) {
    facilityHourOverrides = { ...facilityHourOverrides, [dateIso]: override };
  } else {
    const next = { ...facilityHourOverrides };
    delete next[dateIso];
    facilityHourOverrides = next;
  }
  await saveAutomationSettings({
    calendar_settings: calendarSettingsPayload()
  });
}

async function renderCalendarPage() {
  const root = document.getElementById("feedbackContent");
  if (!root) return;
  root.classList.add("calendar-admin-page");
  root.classList.toggle("calendar-readonly-page", !isAccountManager(appUserSession));
  root.classList.toggle("calendar-member-owned-page", canRequestCalendarEventChanges(appUserSession));
  deferContentUntilReady(root);

  try {
    const token = currentAuthSession?.access_token || "";
    if (!token) throw new Error("Please sign in again.");
    const [eventsResult, requestsResult] = await Promise.all([
      fetch("/api/events", {
        headers: { Authorization: `Bearer ${token}` }
      }),
      (isAccountManager(appUserSession) || canRequestCalendarEventChanges(appUserSession))
        ? fetchCalendarEventRequests()
        : Promise.resolve({ requests: [] })
    ]);
    const body  = await eventsResult.json();
    if (!eventsResult.ok || !body.success) throw new Error(body.error || "Could not load events");
    const sharedHours = body.facilityHours || {};
    facilityHours = normalizeFacilityHours(sharedHours);
    facilityHourOverrides = normalizeFacilityHourOverrides(sharedHours.overrides || {});
    calendarFacilityBlocks = Array.isArray(body.facilityBlocks) ? body.facilityBlocks : [];
    calendarEvents = body.events || [];
    calendarEventRequests = requestsResult.requests || [];
    if (canViewOwnedCalendarEvents(appUserSession) && calendarEventRequests.length) {
      updateOwnedCalendarEventAvailability([], calendarEventRequests);
    }
    renderCalendarView(root);
    if (pendingCalendarRentalCreate) {
      if (!isAccountManager(appUserSession)) {
        pendingCalendarRentalCreate = false;
        return;
      }
      pendingCalendarRentalCreate = false;
      openNewRentalCalendarModal(root);
    }
    const canOpenPendingMemberEvent = isAccountManager(appUserSession) || canRequestCalendarEventChanges(appUserSession);
    if (pendingCalendarMemberCreate && canOpenPendingMemberEvent) {
      pendingCalendarMemberCreate = false;
      openCalendarModal(root, null, null);
    }
    if (pendingCalendarMemberEditId && canOpenPendingMemberEvent) {
      const editId = pendingCalendarMemberEditId;
      pendingCalendarMemberEditId = "";
      const event = calendarEvents.find((ev) => ev.id === editId);
      if (event && canEditCalendarEventForSession(event)) openCalendarModal(root, event, null);
    }
  } catch (err) {
    revealReadyContent(root);
    root.innerHTML = `<p class="feedback-empty">Could not load calendar: ${escapeHtml(err.message)}</p>`;
  }
}

function getRecurringEventsForMonth(year, month) {
  return [];
}

function renderCalendarView(root) {
  revealReadyContent(root);

  const canManageCalendar = isAccountManager(appUserSession);
  const canRequestCalendar = canRequestCalendarEventChanges(appUserSession);
  const canAddCalendarEvent = canManageCalendar || canRequestCalendar;
  const viewerEvents = calendarEventsForCurrentViewer();
  const now   = new Date();
  const year  = calendarYear;
  const month = calendarMonth;

  const firstDay   = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName   = new Date(year, month, 1).toLocaleString("en-US", { month: "long" });

  // Group events by date string "YYYY-MM-DD" — recurring first so they appear at top
  const byDate = {};
  getRecurringEventsForMonth(year, month).forEach((ev) => {
    const d = ev.startAt.slice(0, 10);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(ev);
  });
  viewerEvents.forEach((ev) => {
    const d = calendarTimestampDateKey(ev.startAt, ev.allDay);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(ev);
  });

  // Build day cells
  let cells = "";
  for (let blank = 0; blank < firstDay; blank++) {
    cells += `<div class="cal-cell cal-cell-blank"></div>`;
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const iso     = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dayEvs  = (byDate[iso] || []).filter((ev) => !ev.detailOnly);
    const isToday = iso === facilityDateKey(now);
    const dayEventRows = dayEvs.slice(0, 3).map((ev) => {
      const color = EVENT_COLORS[ev.eventType] || "#8a97a8";
      const title = escapeHtml(ev.title || "Event");
      const pendingTitle = ev.pendingRequestId ? `${title} (pending)` : title;
      return `
        <div class="cal-day-mini-event${ev.pendingRequestId ? " cal-day-mini-event-pending" : ""}">
          <span class="cal-dot" style="background:${color}"></span>
          <span class="cal-day-mini-title">${pendingTitle}</span>
        </div>`;
    }).join("");
    const overflowCount = dayEvs.length - 3;
    const overflowRow = overflowCount > 0
      ? `<div class="cal-day-mini-more">+${overflowCount} more</div>`
      : "";

    cells += `
      <div class="cal-cell${isToday ? " cal-today" : ""}" data-cal-date="${iso}">
        <span class="cal-day-num">${d}</span>
        <div class="cal-dots">${dayEventRows}${overflowRow}</div>
      </div>`;
  }

  root.innerHTML = `
    ${renderCalendarRequestNotice()}
    ${renderCalendarRequestsAdminPanel()}
    <div class="cal-toolbar">
      <button class="app-admin-btn app-admin-btn-secondary cal-nav" id="calPrev">&#8249;</button>
      <span class="cal-month-label">${monthName} ${year}</span>
      <button class="app-admin-btn app-admin-btn-secondary cal-nav" id="calNext">&#8250;</button>
      ${canAddCalendarEvent ? `<button class="app-admin-btn app-admin-btn-primary cal-new-btn" id="calNewEvent">+ New Event</button>` : ""}
    </div>

    <div class="cal-grid">
      <div class="cal-header">Sun</div>
      <div class="cal-header">Mon</div>
      <div class="cal-header">Tue</div>
      <div class="cal-header">Wed</div>
      <div class="cal-header">Thu</div>
      <div class="cal-header">Fri</div>
      <div class="cal-header">Sat</div>
      ${cells}
    </div>

    <div id="calDayPanel" class="cal-day-panel" hidden></div>

    <div id="calHoursModal" class="cal-modal" hidden>
      <div class="cal-modal-inner">
        <h3 id="calHoursTitle" class="cal-modal-heading">Facility Hours</h3>
        <div id="calHoursError" class="feedback-error" hidden></div>
        <label class="cal-checkbox-line">
          <input id="calHoursClosed" type="checkbox" />
          Closed this day
        </label>
        <div class="cal-field-row">
          <label class="cal-field-label">Start
            <input id="calHoursStart" class="rorc-input" type="time" />
          </label>
          <label class="cal-field-label">End
            <input id="calHoursEnd" class="rorc-input" type="time" />
          </label>
        </div>
        <div class="cal-modal-actions">
          <button class="app-admin-btn app-admin-btn-secondary" id="calHoursDefault" type="button">Use Default</button>
          <button class="app-admin-btn app-admin-btn-secondary" id="calHoursCancel">Cancel</button>
          <button class="app-admin-btn app-admin-btn-primary" id="calHoursSave">Save Hours</button>
        </div>
      </div>
    </div>

    <div id="calEventModal" class="cal-modal" hidden>
      <div class="cal-modal-inner">
        <h3 id="calModalTitle" class="cal-modal-heading">New Event</h3>
        <div id="calModalError" class="feedback-error" hidden></div>
        <div id="calRequesterInfo" class="cal-requester-info" hidden></div>

        <label class="cal-field-label">Title
          <input id="calEvTitle" class="rorc-input" type="text" maxlength="200" placeholder="Event title" />
        </label>
        <label class="cal-field-label">Type
          <select id="calEvType" class="rorc-input">
            ${Object.entries(EVENT_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
          </select>
        </label>
        <label class="cal-field-label">Date
          <input id="calEvDate" class="rorc-input" type="date" />
        </label>
        <div class="cal-field-row">
          <label class="cal-field-label">Start Time
            <input id="calEvStart" class="rorc-input" type="time" />
          </label>
          <label class="cal-field-label">End Time
            <input id="calEvEnd" class="rorc-input" type="time" />
          </label>
        </div>
        <label class="cal-field-label cal-field-check">
          <input id="calEvAllDay" type="checkbox" />
          All Day
        </label>
        <label class="cal-field-label cal-field-check">
          <input id="calEvPublic" type="checkbox" />
          Public event (visible on website)
        </label>
        <label class="cal-field-label cal-field-check">
          <input id="calEvDetailOnly" type="checkbox" />
          Show only in day details (hide from month cells)
        </label>
        <label class="cal-field-label">Description (optional)
          <textarea id="calEvDesc" class="rorc-input" rows="3" placeholder="Any notes…"></textarea>
        </label>
        <div class="cal-recurring-box">
          <label class="cal-field-label cal-field-check">
            <input id="calEvRecurring" type="checkbox" />
            Is this recurring?
          </label>
          <div id="calRecurringFields" class="cal-recurring-fields" hidden>
            <div class="cal-field-row">
              <label class="cal-field-label">Repeat every
                <input id="calRecurringEvery" class="rorc-input" type="number" min="1" max="24" value="1" />
              </label>
              <label class="cal-field-label">Unit
                <select id="calRecurringUnit" class="rorc-input">
                  <option value="day">day</option>
                  <option value="week" selected>week</option>
                  <option value="month">month</option>
                  <option value="year">year</option>
                </select>
              </label>
            </div>
            <div class="cal-recurring-days" role="group" aria-label="Recurring days">
              <label><input type="checkbox" data-rec-day="0" />S</label>
              <label><input type="checkbox" data-rec-day="1" />M</label>
              <label><input type="checkbox" data-rec-day="2" />T</label>
              <label><input type="checkbox" data-rec-day="3" />W</label>
              <label><input type="checkbox" data-rec-day="4" />T</label>
              <label><input type="checkbox" data-rec-day="5" />F</label>
              <label><input type="checkbox" data-rec-day="6" />S</label>
            </div>
            <fieldset class="cal-recurring-ends">
              <legend>Ends</legend>
              <label><input type="radio" name="calRecurringEndsMode" value="never" checked /> Never</label>
              <label><input type="radio" name="calRecurringEndsMode" value="on" /> On</label>
              <input id="calRecurringEndDate" class="rorc-input" type="date" disabled />
              <label><input type="radio" name="calRecurringEndsMode" value="after" /> After</label>
              <input id="calRecurringCount" class="rorc-input" type="number" min="1" max="240" value="12" disabled />
            </fieldset>
            <p class="cal-recurring-note">Creates separate events for each date so each one can be edited/deleted independently.</p>
          </div>
        </div>

        <details id="calRentalDetails" class="cal-rental-details" hidden>
          <summary>Booking details</summary>
          <div class="cal-rental-fields">
            <label class="cal-field-label">Contact Name
              <input id="calRentalContactName" class="rorc-input" type="text" placeholder="Start typing an active member name" autocomplete="off" />
              <div id="calRentalContactSuggestions" class="cal-rental-contact-suggestions" hidden></div>
            </label>
            <div class="cal-field-row">
              <label class="cal-field-label">Phone
                <input id="calRentalContactPhone" class="rorc-input" type="tel" />
              </label>
              <label class="cal-field-label">Email
                <input id="calRentalContactEmail" class="rorc-input" type="email" />
              </label>
            </div>
            <label class="cal-field-label">Mailing Address
              <input id="calRentalContactAddress" class="rorc-input" type="text" />
            </label>
            <div class="cal-field-row">
              <label class="cal-field-label">Rental Category
                <select id="calRentalEventType" class="rorc-input">
                  <option>Birthday Party</option>
                  <option>Private Party</option>
                  <option>Meeting</option>
                  <option>Memorial Service</option>
                  <option>Other</option>
                </select>
              </label>
              <label class="cal-field-label">Attendance
                <input id="calRentalAttendance" class="rorc-input" type="number" min="0" inputmode="numeric" />
              </label>
            </div>
            <div class="cal-field-row">
              <label class="cal-field-label">Food or drinks
                <select id="calRentalFood" class="rorc-input">
                  <option value="false">No</option>
                  <option value="true">Yes</option>
                </select>
              </label>
              <label class="cal-field-label">Alcohol
                <select id="calRentalAlcohol" class="rorc-input">
                  <option>No</option>
                  <option>Yes</option>
                </select>
              </label>
            </div>
            <div class="cal-field-row">
              <label class="cal-field-label">Private Event
                <select id="calRentalPrivateEvent" class="rorc-input">
                  <option value="true" selected>Yes - private rate</option>
                  <option value="false">No - $5/hr non-private rate</option>
                </select>
              </label>
              <label id="calRentalSpecialAccessDiscountWrap" class="cal-field-label cal-field-check" hidden>
                <input id="calRentalSpecialAccessDiscount" type="checkbox" />
                Special Access discount applied (20%)
              </label>
            </div>
            <div class="cal-rental-derived-card" aria-live="polite">
              <div class="cal-rental-derived-head">
                <span class="cal-rental-derived-kicker">Rental schedule</span>
                <strong id="calRentalScheduleSummary">Set the event date and time above.</strong>
              </div>
              <div class="cal-rental-derived-grid">
                <span>
                  <small>Billing type</small>
                  <b id="calRentalTypeSummary">All Day</b>
                </span>
                <span>
                  <small>Billable hours</small>
                  <b id="calRentalHoursSummary">-</b>
                </span>
                <span>
                  <small>Base rental</small>
                  <b id="calRentalBaseSummary">$100.00</b>
                </span>
                <span>
                  <small>Estimated total</small>
                  <b id="calRentalTotal">$100.00</b>
                </span>
              </div>
              <p class="cal-rental-derived-note">Uses the event date and time above, matching the public rental form.</p>
            </div>
            <input id="calRentalType" type="hidden" value="all_day" />
            <input id="calRentalHours" type="hidden" value="" />
            <input id="calRentalPublicStart" type="hidden" value="" />
            <input id="calRentalPublicEnd" type="hidden" value="" />
            <div class="cal-rental-addon-grid">
              <label><input id="calRentalCleaning" type="checkbox" /> Standard Maintenance Fee</label>
              <label><input id="calRentalTables" type="checkbox" /> Tables</label>
              <label><input id="calRentalChairs" type="checkbox" /> Chairs</label>
              <label><input id="calRentalTarp" type="checkbox" /> Tarp</label>
              <label><input id="calRentalHeater" type="checkbox" /> Heater</label>
              <label><input id="calRentalAc" type="checkbox" /> AC ($2/hr)</label>
              <label><input id="calRentalEarlySetup" type="checkbox" /> Early setup</label>
              <label><input id="calRentalEarlyDay" type="checkbox" /> Extra day early</label>
              <label><input id="calRentalLateCleanup" type="checkbox" /> Late cleanup</label>
              <label><input id="calRentalLateDay" type="checkbox" /> Extra day late</label>
            </div>
            <label class="cal-field-label">Admin Notes
              <textarea id="calRentalAdminNotes" class="rorc-input" rows="3"></textarea>
            </label>
          </div>
        </details>

        <div id="calRentalInfo" class="cal-rental-info" hidden></div>

        <div class="cal-modal-actions">
          <button class="app-admin-btn app-admin-btn-secondary" id="calModalCancel">Cancel</button>
          <button class="app-admin-btn app-admin-btn-primary" id="calModalSave">Save Event</button>
          <button class="app-admin-btn app-admin-btn-danger" id="calModalDelete" hidden>Delete</button>
        </div>
      </div>
    </div>

  `;

  bindCalendarEvents(root);
}

function bindCalendarEvents(root) {
  const canManageCalendar = isAccountManager(appUserSession);
  const canRequestCalendar = canRequestCalendarEventChanges(appUserSession);
  const canEditCalendar = canManageCalendar || canRequestCalendar;

  root.querySelector("#calPrev").addEventListener("click", () => {
    calendarMonth--;
    if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
    renderCalendarView(root);
  });

  root.querySelector("#calNext").addEventListener("click", () => {
    calendarMonth++;
    if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
    renderCalendarView(root);
  });

  root.querySelector("#calNewEvent")?.addEventListener("click", () => {
    openCalendarModal(root, null, null);
  });

  root.querySelectorAll(".cal-cell[data-cal-date]").forEach((cell) => {
    cell.addEventListener("click", () => {
      const date = cell.dataset.calDate;
      showCalDayPanel(root, date);
    });
  });

  root.querySelector("#calModalCancel")?.addEventListener("click", () => {
    root.querySelector("#calEventModal").hidden = true;
  });

  if (canManageCalendar) {
    root.querySelectorAll("[data-calendar-request-action]").forEach((button) => {
      button.addEventListener("click", () => {
        reviewCalendarEventRequest(root, button.dataset.requestId, button.dataset.calendarRequestAction);
      });
    });
  }

  if (!canEditCalendar) return;

  root.querySelector("#calModalSave")?.addEventListener("click", () => saveCalendarEvent(root));
  root.querySelector("#calModalDelete")?.addEventListener("click", () => deleteCalendarEvent(root));
  if (canManageCalendar) {
    root.querySelector("#calHoursCancel")?.addEventListener("click", () => {
      root.querySelector("#calHoursModal").hidden = true;
    });
    root.querySelector("#calHoursSave")?.addEventListener("click", () => {
      saveFacilityHoursFromModal(root);
    });
    root.querySelector("#calHoursDefault")?.addEventListener("click", () => {
      saveFacilityHoursDefaultFromModal(root);
    });
    root.querySelector("#calHoursClosed")?.addEventListener("change", () => {
      syncFacilityHoursModalState(root);
    });
  }
  root.querySelector("#calEvType")?.addEventListener("change", () => {
    syncCalendarRentalDetailsVisibility(root);
    syncRecurringVisibility(root);
    syncCalendarRentalScheduleFromEvent(root);
  });
  ["calEvDate", "calEvStart", "calEvEnd", "calEvAllDay"].forEach((id) => {
    const field = root.querySelector(`#${id}`);
    field?.addEventListener("input", () => syncCalendarRentalScheduleFromEvent(root));
    field?.addEventListener("change", () => syncCalendarRentalScheduleFromEvent(root));
  });
  root.querySelector("#calEvRecurring")?.addEventListener("change", () => syncRecurringVisibility(root));
  root.querySelector("#calRecurringUnit")?.addEventListener("change", () => syncRecurringVisibility(root));
  root.querySelectorAll("input[name='calRecurringEndsMode']").forEach((radio) => {
    radio.addEventListener("change", () => syncRecurringVisibility(root));
  });
  if (canManageCalendar) {
    bindCalendarRentalContactAutocomplete(root);
  }
  [
    "calRentalPrivateEvent",
    "calRentalSpecialAccessDiscount",
    "calRentalCleaning",
    "calRentalTables",
    "calRentalChairs",
    "calRentalTarp",
    "calRentalHeater",
    "calRentalAc",
    "calRentalEarlySetup",
    "calRentalEarlyDay",
    "calRentalLateCleanup",
    "calRentalLateDay"
  ].forEach((id) => {
    const field = root.querySelector(`#${id}`);
    field?.addEventListener("input", () => {
      if (id === "calRentalPrivateEvent") syncCalendarRentalScheduleFromEvent(root);
      else updateCalendarRentalTotal(root);
    });
    field?.addEventListener("change", () => {
      if (id === "calRentalPrivateEvent") syncCalendarRentalScheduleFromEvent(root);
      else updateCalendarRentalTotal(root);
    });
  });
}

function calendarJumpToDate(dateIso) {
  if (!dateIso) return;
  const d = new Date(dateIso + "T12:00:00");
  calendarYear  = d.getFullYear();
  calendarMonth = d.getMonth();
}

function showCalDayPanel(root, dateIso) {
  const panel  = root.querySelector("#calDayPanel");
  const viewerEvents = calendarEventsForCurrentViewer();
  const dayEvs = viewerEvents.filter((ev) => calendarTimestampDateKey(ev.startAt, ev.allDay) === dateIso);
  const label  = new Date(dateIso + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const hasHourOverride = Boolean(facilityHourOverrides[dateIso]);
  const canManageCalendar = isAccountManager(appUserSession);
  const canRequestCalendar = canRequestCalendarEventChanges(appUserSession);
  const canAddCalendarEvent = canManageCalendar || canRequestCalendar;

  const evHtml = dayEvs.length
    ? dayEvs.map((ev) => `
        <div class="cal-day-event"${ev.id ? ` data-ev-id="${ev.id}"` : ""}>
          <span class="cal-day-event-dot" style="background:${EVENT_COLORS[ev.eventType] || "#8a97a8"}"></span>
          <div class="cal-day-event-info">
            <strong>${escapeHtml(ev.title)}</strong>
            <span>${ev.allDay ? "All Day" : escapeHtml(facilityTimeRange(ev.startAt, ev.endAt))}</span>
            ${ev.pendingRequestId ? `<span class="cal-recurring-badge">Pending approval</span>` : ""}
            ${ev.isRecurring ? `<span class="cal-recurring-badge">Recurring</span>` : ""}
            ${canManageCalendar && ev.id ? `<span class="cal-day-event-badge">${ev.isPublic ? "Public" : "Private"}</span>` : ""}
            ${canManageCalendar && ev.eventType === "rental" && ev.rentalRequestId ? `<span class="cal-day-event-badge cal-rental-link" data-rental-id="${escapeAttribute(ev.rentalRequestId)}">View Rental Request →</span>` : ""}
          </div>
          ${canEditCalendarEventForSession(ev) ? `<button class="cal-day-edit-btn" data-ev-id="${ev.id}" title="Edit">Edit</button>` : ""}
        </div>`)
      .join("")
    : `<p class="cal-day-empty">No events on this day.</p>`;

  panel.hidden = false;
  panel.innerHTML = `
    <div class="cal-day-header">
      <strong>${escapeHtml(label)}</strong>
      ${canAddCalendarEvent ? `<button class="cal-day-add-btn" data-date="${dateIso}">+ Add Event</button>` : ""}
    </div>
    <div class="cal-hours-strip">
      <span class="cal-hours-label">Facility hours</span>
      <span class="cal-hours-value">${escapeHtml(facilityHoursDisplayForDate(dateIso))}${hasHourOverride ? " (custom)" : ""}</span>
      ${canManageCalendar ? `<button class="cal-hours-edit-btn" type="button">Edit</button>` : ""}
    </div>
    ${evHtml}
  `;

  panel.querySelector(".cal-day-add-btn")?.addEventListener("click", (e) => {
    openCalendarModal(root, null, e.currentTarget.dataset.date);
  });
  panel.querySelector(".cal-hours-edit-btn")?.addEventListener("click", () => {
    openFacilityHoursModal(root, dateIso);
  });

  panel.querySelectorAll(".cal-day-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ev = calendarEvents.find((e) => e.id === btn.dataset.evId);
      if (ev && canEditCalendarEventForSession(ev)) openCalendarModal(root, ev, null);
    });
  });

  panel.querySelectorAll(".cal-rental-link").forEach((link) => {
    link.style.cursor = "pointer";
    link.addEventListener("click", () => {
      highlightRentalId  = link.dataset.rentalId;
      rentalActiveFilter = rentalFilterKeyForRequest(rentalAllRequests.find((r) => r.id === highlightRentalId));
      navigateTo("rentalReviews");
    });
  });
}

function syncFacilityHoursModalState(root) {
  const closed = Boolean(root.querySelector("#calHoursClosed")?.checked);
  const startInput = root.querySelector("#calHoursStart");
  const endInput = root.querySelector("#calHoursEnd");
  if (startInput) startInput.disabled = closed;
  if (endInput) endInput.disabled = closed;
}

function openFacilityHoursModal(root, dateIso = "") {
  if (!isAccountManager(appUserSession)) return;
  const modal = root.querySelector("#calHoursModal");
  const errEl = root.querySelector("#calHoursError");
  if (!modal) return;
  if (errEl) errEl.hidden = true;
  const title = root.querySelector("#calHoursTitle");
  const dateLabel = dateIso
    ? new Date(`${dateIso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "";
  modal.dataset.date = dateIso;
  if (title) title.textContent = dateIso ? `Facility Hours - ${dateLabel}` : "Facility Hours";
  const hours = facilityHoursForDate(dateIso);
  root.querySelector("#calHoursClosed").checked = Boolean(hours.closed);
  root.querySelector("#calHoursStart").value = hours.closed ? facilityHours.start : hours.start;
  root.querySelector("#calHoursEnd").value = hours.closed ? facilityHours.end : hours.end;
  root.querySelector("#calHoursDefault").hidden = !dateIso || !facilityHourOverrides[dateIso];
  syncFacilityHoursModalState(root);
  modal.hidden = false;
}

async function saveFacilityHoursFromModal(root) {
  if (!isAccountManager(appUserSession)) return;
  const modal = root.querySelector("#calHoursModal");
  const errEl = root.querySelector("#calHoursError");
  if (errEl) errEl.hidden = true;
  const start = root.querySelector("#calHoursStart")?.value || DEFAULT_FACILITY_HOURS.start;
  const end = root.querySelector("#calHoursEnd")?.value || DEFAULT_FACILITY_HOURS.end;
  const dateIso = modal?.dataset?.date || "";
  const closed = Boolean(root.querySelector("#calHoursClosed")?.checked);
  try {
    if (!closed && (minutesFromTimeValue(start) === null || minutesFromTimeValue(end) === null || minutesFromTimeValue(end) <= minutesFromTimeValue(start))) {
      throw new Error("End time must be after start time.");
    }
    if (dateIso) {
      await saveFacilityHourOverrideToServer(dateIso, closed ? { closed: true } : { start, end });
    } else {
      await saveFacilityHoursToServer({ start, end });
    }
    modal.hidden = true;
    const selectedDate = dateIso || root.querySelector("#calDayPanel .cal-day-add-btn")?.getAttribute("data-date");
    if (selectedDate) showCalDayPanel(root, selectedDate);
  } catch (error) {
    showCalError(errEl, error.message || "Could not save facility hours.");
  }
}

async function saveFacilityHoursDefaultFromModal(root) {
  if (!isAccountManager(appUserSession)) return;
  const modal = root.querySelector("#calHoursModal");
  const errEl = root.querySelector("#calHoursError");
  const dateIso = modal?.dataset?.date || "";
  if (!dateIso) return;
  if (errEl) errEl.hidden = true;
  try {
    await saveFacilityHourOverrideToServer(dateIso, null);
    modal.hidden = true;
    showCalDayPanel(root, dateIso);
  } catch (error) {
    showCalError(errEl, error.message || "Could not reset facility hours.");
  }
}

function openCalendarModal(root, event, prefillDate) {
  const canManageCalendar = isAccountManager(appUserSession);
  const canRequestCalendar = canRequestCalendarEventChanges(appUserSession);
  if (!canManageCalendar && !canRequestCalendar) return;
  if (!canManageCalendar && event && !canEditCalendarEventForSession(event)) return;
  const modal     = root.querySelector("#calEventModal");
  const titleEl   = root.querySelector("#calModalTitle");
  const deleteBtn = root.querySelector("#calModalDelete");
  const errEl     = root.querySelector("#calModalError");
  const rentalInfo = root.querySelector("#calRentalInfo");
  const requesterInfo = root.querySelector("#calRequesterInfo");

  errEl.hidden = true;
  modal.dataset.evId = event ? event.id : "";
  modal.dataset.rentalRequestId = event?.rentalRequestId || "";
  modal.dataset.seriesId = event ? parseSeriesToken(event.createdBy) : "";
  modal.dataset.createdBy = event?.createdBy || "admin";
  modal.dataset.rentalLoaded = "";
  modal.dataset.originalStart = event ? facilityTimeInputValue(event.startAt) : "";
  modal.dataset.originalEnd = event ? facilityTimeInputValue(event.endAt) : "";
  modal.dataset.originalAllDay = event ? String(Boolean(event.allDay)) : "false";
  modal.dataset.rentalPublicStart = "";
  modal.dataset.rentalPublicEnd = "";
  modal.dataset.rentalAccessStart = "";
  modal.dataset.rentalAccessEnd = "";
  modal.dataset.calendarOwnerId = event ? calendarOwnerIdFromCreatedBy(event.createdBy) : "";
  modal.dataset.calendarOwnerAccountId = "";
  modal.dataset.calendarOwnerName = "";

  titleEl.textContent = canManageCalendar
    ? (event ? "Edit Event" : "New Event")
    : (event ? "Request Event Edit" : "Request New Event");
  deleteBtn.hidden    = !event || (!canManageCalendar && !canEditCalendarEventForSession(event));
  deleteBtn.textContent = canManageCalendar ? "Delete" : "Request Delete";

  root.querySelector("#calEvTitle").value   = event ? event.title : "";
  root.querySelector("#calEvType").value    = canManageCalendar && event ? normalizeEventTypeForUi(event.eventType) : "rorc";
  root.querySelector("#calEvDate").value    = event ? calendarTimestampDateKey(event.startAt, event.allDay) : (prefillDate || "");
  root.querySelector("#calEvStart").value   = event ? facilityTimeInputValue(event.startAt) : "";
  root.querySelector("#calEvEnd").value     = event ? facilityTimeInputValue(event.endAt) : "";
  root.querySelector("#calEvAllDay").checked  = event ? event.allDay : false;
  root.querySelector("#calEvPublic").checked  = canManageCalendar ? (event ? event.isPublic : false) : true;
  root.querySelector("#calEvDetailOnly").checked = event ? Boolean(event.detailOnly) : false;
  root.querySelector("#calEvDesc").value    = event ? (event.description || "") : "";
  root.querySelector("#calEvRecurring").checked = false;
  root.querySelector("#calRecurringEvery").value = "1";
  root.querySelector("#calRecurringUnit").value = "week";
  root.querySelector("input[name='calRecurringEndsMode'][value='after']").checked = true;
  root.querySelector("#calRecurringEndDate").value = "";
  root.querySelector("#calRecurringEndDate").disabled = true;
  root.querySelector("#calRecurringCount").value = "12";
  root.querySelectorAll("[data-rec-day]").forEach((input) => {
    input.checked = false;
  });
  const seedDate = root.querySelector("#calEvDate").value;
  if (seedDate) {
    const seedDow = new Date(`${seedDate}T12:00:00`).getDay();
    const seedInput = root.querySelector(`[data-rec-day="${seedDow}"]`);
    if (seedInput) seedInput.checked = true;
  }

  const typeField = root.querySelector("#calEvType");
  const publicField = root.querySelector("#calEvPublic");
  if (typeField) typeField.disabled = !canManageCalendar;
  if (publicField) publicField.disabled = !canManageCalendar;

  if (requesterInfo) {
    const snapshot = currentMemberCalendarSnapshot();
    requesterInfo.hidden = canManageCalendar;
    requesterInfo.innerHTML = canManageCalendar ? "" : `
      <span class="cal-requester-kicker">Submitted as</span>
      <strong>${escapeHtml(snapshot.memberName || "Member account")}</strong>
      <span>${escapeHtml(snapshot.accountType)}${snapshot.emailAddress ? ` · ${escapeHtml(snapshot.emailAddress)}` : ""}${snapshot.phoneNumber ? ` · ${escapeHtml(snapshot.phoneNumber)}` : ""}</span>
      <small>Your member details are attached to this request and cannot be edited here.</small>
    `;
  }

  resetCalendarRentalFields(root, event?.title || "");
  syncCalendarRentalDetailsVisibility(root, canManageCalendar && !event && normalizeEventTypeForUi(root.querySelector("#calEvType").value) === "rental");
  syncRecurringVisibility(root);
  if (!canManageCalendar) {
    root.querySelector("#calRentalDetails").hidden = true;
    root.querySelector("#calRentalDetails").open = false;
  }

  rentalInfo.hidden = true;
  rentalInfo.innerHTML = "";

  if (canManageCalendar && event?.rentalRequestId) {
    loadCalRentalInfo(root, event.rentalRequestId);
  }

  const saveBtn = root.querySelector("#calModalSave");
  if (saveBtn) saveBtn.textContent = canManageCalendar ? "Save Event" : "Submit Request";
  modal.hidden = false;
}

function syncRecurringVisibility(root) {
  const modal = root.querySelector("#calEventModal");
  const recurringToggle = root.querySelector("#calEvRecurring");
  const recurringFields = root.querySelector("#calRecurringFields");
  const recurringUnit = root.querySelector("#calRecurringUnit")?.value || "week";
  const daysWrap = root.querySelector(".cal-recurring-days");
  const endsMode = root.querySelector("input[name='calRecurringEndsMode']:checked")?.value || "never";
  const endDateInput = root.querySelector("#calRecurringEndDate");
  const countInput = root.querySelector("#calRecurringCount");
  const isEditing = Boolean(modal?.dataset?.evId);
  const allowed = !isEditing;
  recurringToggle.disabled = !allowed;
  if (!allowed) recurringToggle.checked = false;
  recurringFields.hidden = !(allowed && recurringToggle.checked);
  if (daysWrap) daysWrap.style.display = recurringUnit === "week" && allowed && recurringToggle.checked ? "flex" : "none";
  if (endDateInput) endDateInput.disabled = endsMode !== "on";
  if (countInput) countInput.disabled = endsMode !== "after";
}

function buildRecurringDateList(seedDate, selectedDays, maxOccurrences) {
  const dates = [];
  const startDate = new Date(`${seedDate}T12:00:00`);
  if (Number.isNaN(startDate.getTime())) return dates;
  const targetDays = new Set(selectedDays);
  const cursor = new Date(startDate);
  let guard = 0;
  while (dates.length < maxOccurrences && guard < 420) {
    guard += 1;
    const dow = cursor.getDay();
    if (targetDays.has(dow)) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function normalizeTimeFieldValue(value) {
  const match = String(value || "").match(/([01]\d|2[0-3]):([0-5]\d)/);
  return match ? `${match[1]}:${match[2]}` : "";
}

function addDaysLocal(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonthsLocal(date, months) {
  const next = new Date(date);
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const endOfMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, endOfMonth));
  return next;
}

function addYearsLocal(date, years) {
  const next = new Date(date);
  const month = next.getMonth();
  const day = next.getDate();
  next.setFullYear(next.getFullYear() + years, month, 1);
  const endOfMonth = new Date(next.getFullYear(), month + 1, 0).getDate();
  next.setDate(Math.min(day, endOfMonth));
  return next;
}

function buildRecurringDateSeries({
  seedDate,
  selectedDays,
  every = 1,
  unit = "week",
  endMode = "never",
  endDate = "",
  occurrences = 12
}) {
  const seed = new Date(`${seedDate}T12:00:00`);
  if (Number.isNaN(seed.getTime())) return [];
  const safeEvery = Math.max(1, Number(every) || 1);
  const targetDays = new Set((selectedDays || []).map(Number).filter((d) => d >= 0 && d <= 6));
  const maxCount = Math.max(1, Number(occurrences) || 1);
  const endDateObj = endDate ? new Date(`${endDate}T12:00:00`) : null;
  const hasEndDate = endDateObj && !Number.isNaN(endDateObj.getTime());
  const hardLimit = endMode === "never" ? 120 : 220;
  const out = [];

  if (unit === "day") {
    let cursor = new Date(seed);
    for (let i = 0; i < hardLimit; i += 1) {
      if (endMode === "on" && hasEndDate && cursor > endDateObj) break;
      out.push(cursor.toISOString().slice(0, 10));
      if (endMode === "after" && out.length >= maxCount) break;
      cursor = addDaysLocal(cursor, safeEvery);
    }
    return out;
  }

  if (unit === "month") {
    let cursor = new Date(seed);
    for (let i = 0; i < hardLimit; i += 1) {
      if (endMode === "on" && hasEndDate && cursor > endDateObj) break;
      out.push(cursor.toISOString().slice(0, 10));
      if (endMode === "after" && out.length >= maxCount) break;
      cursor = addMonthsLocal(cursor, safeEvery);
    }
    return out;
  }

  if (unit === "year") {
    let cursor = new Date(seed);
    for (let i = 0; i < hardLimit; i += 1) {
      if (endMode === "on" && hasEndDate && cursor > endDateObj) break;
      out.push(cursor.toISOString().slice(0, 10));
      if (endMode === "after" && out.length >= maxCount) break;
      cursor = addYearsLocal(cursor, safeEvery);
    }
    return out;
  }

  const selected = targetDays.size ? targetDays : new Set([seed.getDay()]);
  let cursor = new Date(seed);
  let guard = 0;
  while (guard < 900) {
    guard += 1;
    const diffDays = Math.floor((cursor - seed) / 86400000);
    const weekIndex = Math.floor(diffDays / 7);
    const inCycle = weekIndex % safeEvery === 0;
    const isMatchDay = selected.has(cursor.getDay());
    if (inCycle && isMatchDay && cursor >= seed) {
      if (endMode === "on" && hasEndDate && cursor > endDateObj) break;
      out.push(cursor.toISOString().slice(0, 10));
      if (endMode === "after" && out.length >= maxCount) break;
      if (endMode === "never" && out.length >= hardLimit) break;
    }
    cursor = addDaysLocal(cursor, 1);
  }
  return out;
}

function uidSeriesToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function parseSeriesToken(createdBy) {
  const match = String(createdBy || "").match(/(?:^|:)series:([a-zA-Z0-9_-]+)/);
  return match ? match[1] : "";
}

function createdByForSelectedCalendarOwner(root, fallbackCreatedBy = "admin") {
  const modal = root.querySelector("#calEventModal");
  const ownerId = String(modal?.dataset?.calendarOwnerId || "").trim();
  if (!ownerId) return fallbackCreatedBy;
  return `member:${ownerId}:admin`;
}

function cleanCreatedByCore(createdBy) {
  return String(createdBy || "admin")
    .replace(/(^|[:;|])detail(?:$|[:;|])/g, "")
    .replace(/[:;|]{2,}/g, ":")
    .replace(/^[:;|]|[:;|]$/g, "")
    || "admin";
}

function isSameOrAfterFacilityDate(aIso, bIso) {
  return calendarTimestampDateKey(aIso) >= calendarTimestampDateKey(bIso);
}

async function openRecurringDeleteScopeDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "member-delete-confirm-overlay";
    overlay.style.position = "fixed";
    overlay.style.zIndex = "1200";
    overlay.innerHTML = `
      <section class="member-delete-confirm-dialog" role="dialog" aria-modal="true" aria-label="Delete recurring event">
        <h3>Delete recurring event</h3>
        <div class="recurring-delete-options">
          <label><input type="radio" name="recurringDeleteScope" value="this" checked /> This event</label>
          <label><input type="radio" name="recurringDeleteScope" value="following" /> This and following events</label>
          <label><input type="radio" name="recurringDeleteScope" value="all" /> All events</label>
        </div>
        <footer>
          <button class="member-delete-confirm-cancel" type="button">Cancel</button>
          <button class="member-delete-confirm-accept" type="button">OK</button>
        </footer>
      </section>
    `;

    const close = (scope) => {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(scope);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") close("");
    };

    overlay.querySelector(".member-delete-confirm-cancel")?.addEventListener("click", () => close(""));
    overlay.querySelector(".member-delete-confirm-accept")?.addEventListener("click", () => {
      const selected = overlay.querySelector("input[name='recurringDeleteScope']:checked");
      close(selected?.value || "this");
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close("");
    });
    document.addEventListener("keydown", onKeydown);
    document.body.appendChild(overlay);
  });
}

function openNewRentalCalendarModal(root) {
  openCalendarModal(root, null, null);
  root.querySelector("#calEvType").value = "rental";
  syncCalendarRentalDetailsVisibility(root, true);
  syncCalendarRentalScheduleFromEvent(root);
}

function syncCalendarRentalDetailsVisibility(root, shouldOpen = false) {
  const details = root.querySelector("#calRentalDetails");
  if (!details) return;
  const isRental = normalizeEventTypeForUi(root.querySelector("#calEvType")?.value) === "rental";
  details.hidden = !isRental;
  if (isRental && shouldOpen) details.open = true;
  if (!isRental) details.open = false;
  syncCalendarRentalScheduleFromEvent(root);
}

function calendarRentalDerivedSchedule(root) {
  const modal = root.querySelector("#calEventModal");
  const existingLoadedRental = Boolean(modal?.dataset?.rentalRequestId && modal.dataset.rentalLoaded === "true");
  if (existingLoadedRental) {
    const accessStart = normalizeTimeFieldValue(root.querySelector("#calRentalPublicStart")?.value || modal.dataset.rentalAccessStart || "");
    const accessEnd = normalizeTimeFieldValue(root.querySelector("#calRentalPublicEnd")?.value || modal.dataset.rentalAccessEnd || "");
    const rentalType = root.querySelector("#calRentalType")?.value === "hourly" ? "hourly" : "all_day";
    const durationMinutes = minutesFromTimeValue(accessStart) !== null && minutesFromTimeValue(accessEnd) !== null
      ? minutesFromTimeValue(accessEnd) - minutesFromTimeValue(accessStart)
      : 0;
    const rentalHours = rentalType === "hourly"
      ? rentalHoursValue(rentalHoursFromMinutes(durationMinutes) || root.querySelector("#calRentalHours")?.value || 1)
      : "";
    return {
      ready: Boolean(accessStart && accessEnd),
      rentalType,
      rentalHours,
      accessStart,
      accessEnd,
      summary: accessStart && accessEnd
        ? `Rental access from linked request: ${formatHourLabel(accessStart)} - ${formatHourLabel(accessEnd)}`
        : "Linked rental access is missing."
    };
  }

  const date = root.querySelector("#calEvDate")?.value || "";
  const allDay = Boolean(root.querySelector("#calEvAllDay")?.checked);
  const start = normalizeTimeFieldValue(root.querySelector("#calEvStart")?.value || "");
  const end = normalizeTimeFieldValue(root.querySelector("#calEvEnd")?.value || "");
  const hoursForDate = date ? facilityHoursForDate(date) : facilityHours;
  const facilityStart = !hoursForDate?.closed && hoursForDate?.start ? hoursForDate.start : DEFAULT_FACILITY_HOURS.start;
  const facilityEnd = !hoursForDate?.closed && hoursForDate?.end ? hoursForDate.end : DEFAULT_FACILITY_HOURS.end;
  const facilityStartMinutes = minutesFromTimeValue(facilityStart);
  const facilityEndMinutes = minutesFromTimeValue(facilityEnd);

  if (allDay) {
    return {
      ready: true,
      rentalType: "all_day",
      rentalHours: "",
      accessStart: facilityStart,
      accessEnd: facilityEnd,
      summary: `All day rental access: ${formatHourLabel(facilityStart)} - ${formatHourLabel(facilityEnd)}`
    };
  }

  const startMinutes = minutesFromTimeValue(start);
  const endMinutes = minutesFromTimeValue(end);
  if (!start || !end || startMinutes === null || endMinutes === null) {
    return {
      ready: false,
      rentalType: "all_day",
      rentalHours: "",
      accessStart: "",
      accessEnd: "",
      summary: "Set the event start and end time above."
    };
  }
  if (endMinutes <= startMinutes) {
    return {
      ready: false,
      rentalType: "all_day",
      rentalHours: "",
      accessStart: "",
      accessEnd: "",
      summary: "End time must be after start time."
    };
  }

  const duration = endMinutes - startMinutes;
  const isStandardDay = facilityStartMinutes !== null
    && facilityEndMinutes !== null
    && startMinutes === facilityStartMinutes
    && endMinutes === facilityEndMinutes;
  const rentalType = (isStandardDay || duration > 9 * 60) ? "all_day" : "hourly";
  const rentalHours = rentalType === "hourly"
    ? rentalHoursValue(rentalHoursFromMinutes(duration))
    : "";

  return {
    ready: true,
    rentalType,
    rentalHours,
    accessStart: start,
    accessEnd: end,
    summary: `Rental access: ${formatHourLabel(start)} - ${formatHourLabel(end)}`
  };
}

function syncCalendarRentalScheduleFromEvent(root) {
  const details = root.querySelector("#calRentalDetails");
  if (!details) return;
  const schedule = calendarRentalDerivedSchedule(root);
  const typeInput = root.querySelector("#calRentalType");
  const hoursInput = root.querySelector("#calRentalHours");
  const startInput = root.querySelector("#calRentalPublicStart");
  const endInput = root.querySelector("#calRentalPublicEnd");
  const summaryEl = root.querySelector("#calRentalScheduleSummary");
  const typeSummary = root.querySelector("#calRentalTypeSummary");
  const hoursSummary = root.querySelector("#calRentalHoursSummary");
  const baseSummary = root.querySelector("#calRentalBaseSummary");

  if (typeInput) typeInput.value = schedule.rentalType;
  if (hoursInput) hoursInput.value = schedule.rentalHours;
  if (startInput) startInput.value = schedule.accessStart;
  if (endInput) endInput.value = schedule.accessEnd;
  if (summaryEl) {
    summaryEl.textContent = schedule.summary;
    summaryEl.dataset.ready = schedule.ready ? "true" : "false";
  }
  const totalValues = calendarRentalTotalValues(root);
  if (typeSummary) {
    typeSummary.textContent = totalValues.isPrivateEvent
      ? (schedule.rentalType === "hourly" ? "Hourly" : "All Day")
      : "Non-private";
  }
  if (hoursSummary) {
    hoursSummary.textContent = totalValues.isPrivateEvent
      ? (schedule.rentalType === "hourly" ? rentalHoursLabel(schedule.rentalHours) : "-")
      : rentalBillableHoursLabel(rentalHoursBetween(schedule.accessStart, schedule.accessEnd, 1));
  }
  if (baseSummary) {
    const baseCents = rentalBaseCents(totalValues);
    baseSummary.textContent = schedule.ready ? formatCurrency(baseCents) : "-";
  }
  updateCalendarRentalTotal(root);
}

function calendarRentalTotalValues(root) {
  const rentalType = root.querySelector("#calRentalType")?.value === "hourly" ? "hourly" : "all_day";
  const rentalAccessStart = root.querySelector("#calRentalPublicStart")?.value || "";
  const rentalAccessEnd = root.querySelector("#calRentalPublicEnd")?.value || "";
  return {
    rentalType,
    rentalHours: rentalType === "hourly"
      ? normalizeRentalHours(rentalHoursBetween(rentalAccessStart, rentalAccessEnd, root.querySelector("#calRentalHours")?.value || 1))
      : null,
    rentalAccessStart,
    rentalAccessEnd,
    isPrivateEvent: root.querySelector("#calRentalPrivateEvent")?.value !== "false",
    specialAccessDiscount: Boolean(root.querySelector("#calRentalSpecialAccessDiscount")?.checked),
    addonCleaningMaintenance: Boolean(root.querySelector("#calRentalCleaning")?.checked),
    addonTables: Boolean(root.querySelector("#calRentalTables")?.checked),
    addonChairs: Boolean(root.querySelector("#calRentalChairs")?.checked),
    addonTarp: Boolean(root.querySelector("#calRentalTarp")?.checked),
    addonHeater: Boolean(root.querySelector("#calRentalHeater")?.checked),
    addonAc: Boolean(root.querySelector("#calRentalAc")?.checked),
    addonEarlySetup: Boolean(root.querySelector("#calRentalEarlySetup")?.checked),
    addonEarlyDayRental: Boolean(root.querySelector("#calRentalEarlyDay")?.checked),
    addonLateCleanup: Boolean(root.querySelector("#calRentalLateCleanup")?.checked),
    addonLateDayRental: Boolean(root.querySelector("#calRentalLateDay")?.checked)
  };
}

function calculateCalendarRentalTotalCents(root) {
  return calculateRentalTotalCents(calendarRentalTotalValues(root));
}

function updateCalendarRentalTotal(root) {
  const totalEl = root.querySelector("#calRentalTotal");
  if (!totalEl) return;
  const ready = root.querySelector("#calRentalScheduleSummary")?.dataset.ready;
  const totalText = ready === "false" ? "-" : formatCurrency(calculateCalendarRentalTotalCents(root));
  if ("value" in totalEl) totalEl.value = totalText;
  totalEl.textContent = totalText;
}

function setCalendarSpecialAccessDiscountState(root, enabled) {
  const field = root.querySelector("#calRentalSpecialAccessDiscount");
  const wrap = root.querySelector("#calRentalSpecialAccessDiscountWrap");
  const active = Boolean(enabled);
  if (field) {
    field.checked = active;
    field.disabled = true;
  }
  if (wrap) wrap.hidden = !active;
}

function resetCalendarRentalFields(root, title = "") {
  const defaults = {
    calRentalContactName: title,
    calRentalContactPhone: "",
    calRentalContactEmail: "",
    calRentalContactAddress: "",
    calRentalEventType: "Other",
    calRentalAttendance: "1",
    calRentalType: "all_day",
    calRentalHours: "",
    calRentalFood: "false",
    calRentalAlcohol: "No",
    calRentalPrivateEvent: "true",
    calRentalPublicStart: "",
    calRentalPublicEnd: "",
    calRentalAdminNotes: ""
  };

  Object.entries(defaults).forEach(([id, value]) => {
    const el = root.querySelector(`#${id}`);
    if (el) el.value = value;
  });

  [
    "calRentalSpecialAccessDiscount",
    "calRentalCleaning",
    "calRentalTables",
    "calRentalChairs",
    "calRentalTarp",
    "calRentalHeater",
    "calRentalAc",
    "calRentalEarlySetup",
    "calRentalEarlyDay",
    "calRentalLateCleanup",
    "calRentalLateDay"
  ].forEach((id) => {
    const el = root.querySelector(`#${id}`);
    if (el) el.checked = false;
  });
  setCalendarSpecialAccessDiscountState(root, false);
  syncCalendarRentalScheduleFromEvent(root);
}

function populateCalendarRentalFields(root, rental) {
  const values = {
    calRentalContactName: rental.contactName || "",
    calRentalContactPhone: rental.contactPhone || "",
    calRentalContactEmail: rental.contactEmail || "",
    calRentalContactAddress: rental.contactAddress || "",
    calRentalEventType: rental.eventType || "Other",
    calRentalAttendance: rental.estimatedAttendance ?? "",
    calRentalType: rental.rentalType || "all_day",
    calRentalHours: rental.rentalHours || "",
    calRentalFood: rental.foodOrDrinks ? "true" : "false",
    calRentalAlcohol: rental.alcohol === "Yes" ? "Yes" : "No",
    calRentalPrivateEvent: rental.isPrivateEvent === false ? "false" : "true",
    calRentalPublicStart: normalizeTimeFieldValue(rental.eventStartTime || ""),
    calRentalPublicEnd: normalizeTimeFieldValue(rental.eventEndTime || ""),
    calRentalAdminNotes: rental.adminNotes || ""
  };

  Object.entries(values).forEach(([id, value]) => {
    const el = root.querySelector(`#${id}`);
    if (el) el.value = value;
  });

  const checks = {
    calRentalSpecialAccessDiscount: rental.specialAccessDiscount,
    calRentalCleaning: inferRentalCleaningMaintenance(rental),
    calRentalTables: rental.addonTables,
    calRentalChairs: rental.addonChairs,
    calRentalTarp: rental.addonTarp,
    calRentalHeater: rental.addonHeater,
    calRentalAc: rental.addonAc,
    calRentalEarlySetup: rental.addonEarlySetup,
    calRentalEarlyDay: rental.addonEarlyDayRental,
    calRentalLateCleanup: rental.addonLateCleanup,
    calRentalLateDay: rental.addonLateDayRental
  };

  Object.entries(checks).forEach(([id, checked]) => {
    const el = root.querySelector(`#${id}`);
    if (el) el.checked = Boolean(checked);
  });
  setCalendarSpecialAccessDiscountState(root, rental.specialAccessDiscount);

  syncCalendarRentalScheduleFromEvent(root);
}

function bindCalendarRentalContactAutocomplete(root) {
  const input = root.querySelector("#calRentalContactName");
  const suggestions = root.querySelector("#calRentalContactSuggestions");
  if (!input || !suggestions || input.dataset.autocompleteBound === "true") return;

  const clearSelectedOwnerIfChanged = () => {
    const modal = root.querySelector("#calEventModal");
    if (!modal?.dataset?.calendarOwnerName) return;
    if (input.value.trim() === modal.dataset.calendarOwnerName) return;
    modal.dataset.calendarOwnerId = "";
    modal.dataset.calendarOwnerAccountId = "";
    modal.dataset.calendarOwnerName = "";
    setCalendarSpecialAccessDiscountState(root, false);
    updateCalendarRentalTotal(root);
  };

  const hideSuggestions = () => {
    suggestions.hidden = true;
    suggestions.innerHTML = "";
  };

  const renderSuggestions = () => {
    const query = input.value.trim().toLowerCase();
    if (!query) {
      hideSuggestions();
      return;
    }

    const matches = rentalContactAutocompleteMembers()
      .filter((member) => member.memberName.toLowerCase().includes(query))
      .slice(0, 10);

    if (!matches.length) {
      hideSuggestions();
      return;
    }

    suggestions.innerHTML = matches.map((member) => `
      <button class="cal-rental-contact-suggestion" type="button" data-rental-contact-member="${escapeAttribute(member.id)}">
        ${escapeHtml(member.memberName)}
      </button>
    `).join("");
    suggestions.hidden = false;
  };

  input.dataset.autocompleteBound = "true";
  input.addEventListener("input", () => {
    clearSelectedOwnerIfChanged();
    renderSuggestions();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideSuggestions();
      return;
    }
    if (event.key === "Enter" && !suggestions.hidden) {
      const first = suggestions.querySelector("[data-rental-contact-member]");
      if (first) {
        event.preventDefault();
        applyCalendarRentalContactMember(root, first.getAttribute("data-rental-contact-member"));
        hideSuggestions();
      }
    }
  });

  suggestions.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  suggestions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-rental-contact-member]");
    if (!button) return;
    applyCalendarRentalContactMember(root, button.getAttribute("data-rental-contact-member"));
    hideSuggestions();
  });
  document.addEventListener("click", (event) => {
    if (!input.contains(event.target) && !suggestions.contains(event.target)) {
      hideSuggestions();
    }
  });
}

function rentalContactAutocompleteMembers() {
  const seen = new Set();
  const inactiveTypes = new Set(["Kiosk Account", "RESTRICTED ACCOUNT", "Rental Account"]);
  const source = globalMemberDirectory.length ? globalMemberDirectory : accountMembers;
  return source
    .filter((member) => {
      if (!member?.id || seen.has(member.id)) return false;
      seen.add(member.id);
      if (!String(member.memberName || "").trim()) return false;
      return !inactiveTypes.has(canonicalAccountType(member.accountType));
    })
    .sort(sortMembers);
}

function applyCalendarRentalContactMember(root, memberId) {
  const member = findMember(memberId);
  if (!member) return;
  const modal = root.querySelector("#calEventModal");
  const isSpecialAccessMember = canonicalAccountType(member.accountType) === "Special Access Account";
  const canLinkOwner = canOwnCalendarEvents({ id: member.id, accountType: member.accountType });

  const values = {
    calRentalContactName: member.memberName || "",
    calRentalContactPhone: member.phoneNumber || "",
    calRentalContactEmail: member.emailAddress || "",
    calRentalContactAddress: member.mailingAddress || ""
  };

  Object.entries(values).forEach(([id, value]) => {
    const field = root.querySelector(`#${id}`);
    if (field) field.value = value;
  });
  if (modal) {
    modal.dataset.calendarOwnerId = canLinkOwner ? member.id : "";
    modal.dataset.calendarOwnerAccountId = canLinkOwner ? member.accountId || "" : "";
    modal.dataset.calendarOwnerName = canLinkOwner ? String(member.memberName || "").trim() : "";
  }
  setCalendarSpecialAccessDiscountState(root, isSpecialAccessMember);
  updateCalendarRentalTotal(root);
}

function collectCalendarRentalPayload(root, defaults) {
  const rentalType = root.querySelector("#calRentalType")?.value || "all_day";
  const rentalAccessStart = normalizeTimeFieldValue(root.querySelector("#calRentalPublicStart")?.value || "")
    || (defaults.allDay ? "07:00" : (defaults.start || "07:00"));
  const rentalAccessEnd = normalizeTimeFieldValue(root.querySelector("#calRentalPublicEnd")?.value || "")
    || (defaults.allDay ? "21:00" : (defaults.end || "21:00"));
  const rentalHours = rentalType === "hourly"
    ? normalizeRentalHours(rentalHoursBetween(rentalAccessStart, rentalAccessEnd, root.querySelector("#calRentalHours")?.value || 1))
    : null;
  const publicWindow = rentalPublicWindowPatch(defaults);
  const payload = {
    title: defaults.title,
    contact_name: root.querySelector("#calRentalContactName")?.value.trim() || defaults.title || "Admin Booking",
    contact_phone: root.querySelector("#calRentalContactPhone")?.value.trim() || "",
    contact_email: root.querySelector("#calRentalContactEmail")?.value.trim() || "",
    contact_address: root.querySelector("#calRentalContactAddress")?.value.trim() || "",
    event_name: defaults.title,
    event_type: root.querySelector("#calRentalEventType")?.value || "Other",
    event_date: defaults.date,
    event_start_time: rentalAccessStart,
    event_end_time: rentalAccessEnd,
    ...publicWindow,
    estimated_attendance: Math.max(1, Number(root.querySelector("#calRentalAttendance")?.value || 1) || 1),
    food_or_drinks: root.querySelector("#calRentalFood")?.value === "true",
    alcohol: root.querySelector("#calRentalAlcohol")?.value || "No",
    is_private_event: root.querySelector("#calRentalPrivateEvent")?.value !== "false",
    special_access_discount: Boolean(root.querySelector("#calRentalSpecialAccessDiscount")?.checked),
    rental_type: rentalType,
    rental_hours: rentalHours,
    addon_cleaning_maintenance: Boolean(root.querySelector("#calRentalCleaning")?.checked),
    addon_tables: Boolean(root.querySelector("#calRentalTables")?.checked),
    addon_chairs: Boolean(root.querySelector("#calRentalChairs")?.checked),
    addon_tarp: Boolean(root.querySelector("#calRentalTarp")?.checked),
    addon_heater: Boolean(root.querySelector("#calRentalHeater")?.checked),
    addon_ac: Boolean(root.querySelector("#calRentalAc")?.checked),
    addon_early_setup: Boolean(root.querySelector("#calRentalEarlySetup")?.checked),
    addon_early_day_rental: Boolean(root.querySelector("#calRentalEarlyDay")?.checked),
    addon_late_cleanup: Boolean(root.querySelector("#calRentalLateCleanup")?.checked),
    addon_late_day_rental: Boolean(root.querySelector("#calRentalLateDay")?.checked),
    estimated_total_cents: calculateCalendarRentalTotalCents(root),
    adminNotes: root.querySelector("#calRentalAdminNotes")?.value.trim() || null,
    rental_status: "confirmed"
  };
  const ownerId = String(root.querySelector("#calEventModal")?.dataset?.calendarOwnerId || "").trim();
  const ownerAccountId = String(root.querySelector("#calEventModal")?.dataset?.calendarOwnerAccountId || "").trim();
  if (ownerId) payload.claimed_member_id = ownerId;
  if (ownerAccountId) payload.claimed_account_id = ownerAccountId;
  return payload;
}

function collectCalendarRentalSchedulePayload(defaults) {
  return {
    event_name: defaults.title,
    event_date: defaults.date,
    ...rentalPublicWindowPatch(defaults)
  };
}

function rentalPublicWindowPatch(defaults) {
  const originalAllDay = Boolean(defaults.originalAllDay);
  const changedCalendarWindow = originalAllDay !== Boolean(defaults.allDay)
    || String(defaults.originalStart || "") !== String(defaults.start || "")
    || String(defaults.originalEnd || "") !== String(defaults.end || "");
  const hasExistingPublicWindow = Boolean(defaults.rentalPublicStart && defaults.rentalPublicEnd);

  if (defaults.allDay) {
    return defaults.existingRentalId ? { public_event_start_time: null, public_event_end_time: null } : {};
  }

  if (!defaults.start || !defaults.end) return {};
  if (!defaults.existingRentalId || hasExistingPublicWindow || changedCalendarWindow) {
    return { public_event_start_time: defaults.start, public_event_end_time: defaults.end };
  }

  return defaults.rentalLoaded
    ? { public_event_start_time: null, public_event_end_time: null }
    : {};
}

async function loadCalRentalInfo(root, rentalRequestId) {
  const rentalInfo = root.querySelector("#calRentalInfo");
  try {
    const token = currentAuthSession?.access_token || "";
    if (!token) return;
    const res = await fetch("/api/rental-reviews", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await res.json();
    if (!res.ok || !body.success) return;
    const rental = (body.requests || []).find((r) => r.id === rentalRequestId);
    if (!rental) return;
    const modal = root.querySelector("#calEventModal");
    modal.dataset.rentalLoaded = "true";
    modal.dataset.rentalPublicStart = rental.publicEventStartTime || "";
    modal.dataset.rentalPublicEnd = rental.publicEventEndTime || "";
    modal.dataset.rentalAccessStart = normalizeTimeFieldValue(rental.eventStartTime || "");
    modal.dataset.rentalAccessEnd = normalizeTimeFieldValue(rental.eventEndTime || "");
    populateCalendarRentalFields(root, rental);

    const addons = [
      rental.isPrivateEvent === false && "Non-private event",
      rental.specialAccessDiscount && "Special Access 20% discount",
      inferRentalCleaningMaintenance(rental) && "Standard Maintenance Fee",
      rental.addonTables && "Tables",
      rental.addonChairs && "Chairs",
      rental.addonTarp && "Tarp",
      rental.addonHeater && "Heater",
      rental.addonAc && "AC ($2/hr)",
      rental.addonEarlySetup && "Early Setup",
      rental.addonEarlyDayRental && "Extra Day (Early)",
      rental.addonLateCleanup && "Late Cleanup",
      rental.addonLateDayRental && "Extra Day (Late)"
    ].filter(Boolean);

    const totalDollars = rental.estimatedTotalCents ? `$${(rental.estimatedTotalCents / 100).toFixed(2)}` : "—";
    const statusLabel = rental.rentalStatus ? rental.rentalStatus.replace(/_/g, " ") : "—";

    rentalInfo.innerHTML = `
      <div class="cal-rental-divider">Linked Rental</div>
      <div class="cal-rental-row"><span class="cal-rental-label">Contact</span><span>${escapeHtml(rental.contactName || "—")}${rental.contactPhone ? " · " + escapeHtml(rental.contactPhone) : ""}${rental.contactEmail ? " · " + escapeHtml(rental.contactEmail) : ""}</span></div>
      <div class="cal-rental-row"><span class="cal-rental-label">Event</span><span>${escapeHtml(rental.eventType || "—")} · Est. attendance: ${rental.estimatedAttendance ?? "—"}</span></div>
      <div class="cal-rental-row"><span class="cal-rental-label">Rental Access</span><span>${escapeHtml(rental.eventStartTime || "—")} – ${escapeHtml(rental.eventEndTime || "—")}</span></div>
      ${rental.publicEventStartTime && rental.publicEventEndTime ? `<div class="cal-rental-row"><span class="cal-rental-label">Public Time</span><span>${escapeHtml(rental.publicEventStartTime)} – ${escapeHtml(rental.publicEventEndTime)}</span></div>` : ""}
      ${addons.length ? `<div class="cal-rental-row"><span class="cal-rental-label">Add-ons</span><span>${escapeHtml(addons.join(", "))}</span></div>` : ""}
      <div class="cal-rental-row"><span class="cal-rental-label">Total</span><span>${totalDollars}</span></div>
      <div class="cal-rental-row"><span class="cal-rental-label">Status</span><span class="cal-rental-status">${escapeHtml(statusLabel)}</span></div>
      <button class="app-admin-btn app-admin-btn-secondary cal-rental-goto" data-rental-id="${escapeAttribute(rentalRequestId)}">Go to Rental →</button>
    `;
    rentalInfo.hidden = false;

    rentalInfo.querySelector(".cal-rental-goto").addEventListener("click", () => {
      highlightRentalId  = rentalRequestId;
      rentalActiveFilter = rentalFilterKeyForRequest(rental);
      root.querySelector("#calEventModal").hidden = true;
      navigateTo("rentalReviews");
    });
  } catch {
    // silently fail — rental info is supplementary
  }
}

async function submitMemberCalendarRequest(root, options) {
  const modal = root.querySelector("#calEventModal");
  const errEl = root.querySelector("#calModalError");
  const saveBtn = root.querySelector("#calModalSave");
  const targetEvent = options.evId ? calendarEvents.find((event) => event.id === options.evId) : null;

  if (options.evId && !canEditCalendarEventForSession(targetEvent)) {
    showCalError(errEl, "You can only change your own approved events.");
    return;
  }

  errEl.hidden = true;
  saveBtn.disabled = true;
  saveBtn.textContent = "Submitting…";

  try {
    const token = currentAuthSession?.access_token || "";
    if (!token) throw new Error("Please sign in again before submitting.");

    const requestType = options.evId ? "update" : "create";
    const requestBodies = [];

    if (options.recurringEnabled && !options.evId) {
      const dateList = buildRecurringDateSeries({
        seedDate: options.date,
        selectedDays: options.recurringDays,
        every: options.recurringEvery,
        unit: options.recurringUnit,
        endMode: options.recurringEndMode,
        endDate: options.recurringEndDate,
        occurrences: options.recurringCount
      });
      if (!dateList.length) throw new Error("Could not create recurrence from current settings.");
      dateList.forEach((dateKey) => {
        requestBodies.push({
          requestType,
          event: {
            title: options.title,
            event_type: "rorc",
            start_at: options.allDay ? facilityWallTimeToIso(dateKey, "00:00") : facilityWallTimeToIso(dateKey, options.start || "00:00"),
            end_at: options.allDay ? facilityWallTimeToIso(dateKey, "23:59") : facilityWallTimeToIso(dateKey, options.end || "23:59"),
            all_day: options.allDay,
            is_public: true,
            description: options.desc || null,
            detail_only: options.detailOnly
          }
        });
      });
    } else {
      requestBodies.push({
        requestType,
        targetEventId: options.evId || null,
        event: {
          title: options.title,
          event_type: "rorc",
          start_at: options.startAt,
          end_at: options.endAt,
          all_day: options.allDay,
          is_public: true,
          description: options.desc || null,
          detail_only: options.detailOnly
        }
      });
    }

    for (const requestBody of requestBodies) {
      const response = await fetch("/api/calendar-event-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(requestBody)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success === false) {
        throw new Error(body.error || "Could not submit calendar request.");
      }
    }

    calendarRequestNotice = requestBodies.length > 1
      ? `${requestBodies.length} event requests were submitted for approval.`
      : (options.evId ? "Event edit submitted for approval." : "Event submitted for approval.");
    hasOwnedCalendarEvents = true;
    updateNavigationVisibility();
    modal.hidden = true;
    await renderCalendarPage();
  } catch (error) {
    showCalError(errEl, error.message || "Could not submit calendar request.");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Submit Request";
  }
}

async function saveCalendarEvent(root) {
  const canManageCalendar = isAccountManager(appUserSession);
  const canRequestCalendar = canRequestCalendarEventChanges(appUserSession);
  if (!canManageCalendar && !canRequestCalendar) return;
  const modal  = root.querySelector("#calEventModal");
  const errEl  = root.querySelector("#calModalError");
  const saveBtn = root.querySelector("#calModalSave");
  const evId   = modal.dataset.evId;

  const title   = root.querySelector("#calEvTitle").value.trim();
  const type    = root.querySelector("#calEvType").value;
  const date    = root.querySelector("#calEvDate").value;
  const start   = normalizeTimeFieldValue(root.querySelector("#calEvStart").value);
  const end     = normalizeTimeFieldValue(root.querySelector("#calEvEnd").value);
  const allDay  = root.querySelector("#calEvAllDay").checked;
  const isPublic = root.querySelector("#calEvPublic").checked;
  const detailOnly = root.querySelector("#calEvDetailOnly").checked;
  const desc    = root.querySelector("#calEvDesc").value.trim();
  const isRentalEvent = normalizeEventTypeForUi(type) === "rental";
  if (isRentalEvent) syncCalendarRentalScheduleFromEvent(root);
  const recurringEnabled = root.querySelector("#calEvRecurring").checked && !evId;
  const recurringEvery = Math.max(1, Number(root.querySelector("#calRecurringEvery")?.value || 1) || 1);
  const recurringUnit = root.querySelector("#calRecurringUnit")?.value || "week";
  const recurringCount = Math.min(240, Math.max(1, Number(root.querySelector("#calRecurringCount")?.value || 12) || 12));
  const recurringDays = [...root.querySelectorAll("[data-rec-day]:checked")]
    .map((input) => Number(input.getAttribute("data-rec-day")))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
  const recurringEndMode = root.querySelector("input[name='calRecurringEndsMode']:checked")?.value || "never";
  const recurringEndDate = root.querySelector("#calRecurringEndDate")?.value || "";
  const rentalPublicStart = normalizeTimeFieldValue(root.querySelector("#calRentalPublicStart")?.value || "");
  const rentalPublicEnd = normalizeTimeFieldValue(root.querySelector("#calRentalPublicEnd")?.value || "");

  if (!title) { showCalError(errEl, "Title is required."); return; }
  if (!date)  { showCalError(errEl, "Date is required.");  return; }
  if (!allDay && !start) { showCalError(errEl, "Valid start time is required."); return; }
  if (!allDay && !end) { showCalError(errEl, "Valid end time is required."); return; }
  if (recurringEnabled && recurringUnit === "week" && !recurringDays.length) { showCalError(errEl, "Select at least one recurring day."); return; }
  if (recurringEnabled && recurringEndMode === "on" && !recurringEndDate) { showCalError(errEl, "Select an end date."); return; }
  if (modal.dataset.rentalRequestId && normalizeEventTypeForUi(type) !== "rental") {
    showCalError(errEl, "Linked rental calendar events must stay set to Rental. Use Rental Category inside booking details for the rental type.");
    return;
  }
  if (normalizeEventTypeForUi(type) === "rental" && Boolean(rentalPublicStart) !== Boolean(rentalPublicEnd)) {
    showCalError(errEl, "Rental access start/end must both be filled or both be blank.");
    return;
  }

  const startAt = allDay
    ? facilityWallTimeToIso(date, "00:00")
    : facilityWallTimeToIso(date, start || "00:00");
  const endAt = allDay
    ? facilityWallTimeToIso(date, "23:59")
    : facilityWallTimeToIso(date, end || "23:59");

  if (!canManageCalendar) {
    await submitMemberCalendarRequest(root, {
      evId,
      title,
      date,
      start,
      end,
      startAt,
      endAt,
      allDay,
      detailOnly,
      desc,
      recurringEnabled,
      recurringEvery,
      recurringUnit,
      recurringCount,
      recurringDays,
      recurringEndMode,
      recurringEndDate
    });
    return;
  }

  errEl.hidden = true;
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  try {
    const token  = currentAuthSession?.access_token || "";
    if (!token) throw new Error("Please sign in again before saving.");
    const method = evId ? "PATCH" : "POST";
    const existingCreatedBy = String(modal.dataset.createdBy || "admin");
    const selectedOwnerCreatedBy = createdByForSelectedCalendarOwner(root, existingCreatedBy);
    const createdByCore = cleanCreatedByCore(selectedOwnerCreatedBy);
    const createdBy = detailOnly ? `${createdByCore}:detail` : createdByCore;
    const basePayload = { title, event_type: type, start_at: startAt, end_at: endAt, all_day: allDay, is_public: isPublic, description: desc || null, created_by: createdBy };
    const payload = evId ? { ...basePayload, id: evId } : { ...basePayload };

    if (isRentalEvent && !recurringEnabled) {
      const existingRentalId = modal.dataset.rentalRequestId || "";
      const rentalDefaults = {
        title,
        date,
        start,
        end,
        allDay,
        existingRentalId,
        rentalLoaded: modal.dataset.rentalLoaded === "true",
        originalStart: modal.dataset.originalStart || "",
        originalEnd: modal.dataset.originalEnd || "",
        originalAllDay: modal.dataset.originalAllDay === "true",
        rentalPublicStart: modal.dataset.rentalPublicStart || "",
        rentalPublicEnd: modal.dataset.rentalPublicEnd || "",
        rentalAccessStart: modal.dataset.rentalAccessStart || "",
        rentalAccessEnd: modal.dataset.rentalAccessEnd || ""
      };
      const rentalPayload = existingRentalId && modal.dataset.rentalLoaded !== "true"
        ? collectCalendarRentalSchedulePayload(rentalDefaults)
        : collectCalendarRentalPayload(root, rentalDefaults);
      const rrRes = await fetch("/api/rental-reviews", {
        method: existingRentalId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(existingRentalId ? { id: existingRentalId, ...rentalPayload } : rentalPayload)
      });
      const rrBody = await rrRes.json();
      if (!rrRes.ok || !rrBody.success) throw new Error(rrBody.error || "Could not save rental record");
      payload.rental_request_id = existingRentalId || rrBody.id;
      if (existingRentalId && evId) {
        delete payload.start_at;
        delete payload.end_at;
        delete payload.all_day;
      }
    }

    if (recurringEnabled && !evId) {
      const dateList = buildRecurringDateSeries({
        seedDate: date,
        selectedDays: recurringDays,
        every: recurringEvery,
        unit: recurringUnit,
        endMode: recurringEndMode,
        endDate: recurringEndDate,
        occurrences: recurringCount
      });
      if (!dateList.length) throw new Error("Could not create recurrence from current settings.");
      const seriesId = uidSeriesToken();
      const seriesBaseCreatedBy = calendarOwnerIdFromCreatedBy(createdByCore)
        ? `${createdByCore}:series:${seriesId}`
        : `series:${seriesId}`;
      const seriesCreatedBy = detailOnly ? `${seriesBaseCreatedBy}:detail` : seriesBaseCreatedBy;
      const concurrency = 8;
      for (let i = 0; i < dateList.length; i += concurrency) {
        const chunk = dateList.slice(i, i + concurrency);
        const results = await Promise.all(chunk.map(async (dateKey) => {
          const itemStart = allDay
            ? facilityWallTimeToIso(dateKey, "00:00")
            : facilityWallTimeToIso(dateKey, start || "00:00");
          const itemEnd = allDay
            ? facilityWallTimeToIso(dateKey, "23:59")
            : facilityWallTimeToIso(dateKey, end || "23:59");
          const itemPayload = { ...payload, start_at: itemStart, end_at: itemEnd, created_by: seriesCreatedBy };
          if (isRentalEvent) {
            const rentalPayload = collectCalendarRentalPayload(root, {
              title,
              date: dateKey,
              start,
              end,
              allDay,
              existingRentalId: "",
              rentalLoaded: true,
              originalStart: "",
              originalEnd: "",
              originalAllDay: false,
              rentalPublicStart: "",
              rentalPublicEnd: "",
              rentalAccessStart: "",
              rentalAccessEnd: ""
            });
            const rrRes = await fetch("/api/rental-reviews", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify(rentalPayload)
            });
            const rrBody = await rrRes.json().catch(() => ({}));
            if (!rrRes.ok || rrBody.success === false) {
              return { ok: false, body: { error: rrBody.error || "Could not save rental record" } };
            }
            itemPayload.rental_request_id = rrBody.id;
          }
          const res = await fetch("/api/events", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(itemPayload)
          });
          const body = await res.json().catch(() => ({}));
          if ((!res.ok || body.success === false) && isRentalEvent && itemPayload.rental_request_id) {
            await fetch("/api/rental-reviews", {
              method: "DELETE",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ id: itemPayload.rental_request_id, deleteLinkedEvent: false })
            }).catch(() => {});
          }
          return { ok: res.ok && body.success !== false, body };
        }));
        const failed = results.find((result) => !result.ok);
        if (failed) throw new Error(failed.body?.error || "Save failed");
      }
    } else {
      const res  = await fetch("/api/events", {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "Save failed");
    }

    modal.hidden = true;
    await renderCalendarPage();
  } catch (err) {
    showCalError(errEl, err.message || "Could not save event.");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Event";
  }
}

async function deleteCalendarEvent(root) {
  const canManageCalendar = isAccountManager(appUserSession);
  const canRequestCalendar = canRequestCalendarEventChanges(appUserSession);
  if (!canManageCalendar && !canRequestCalendar) return;
  const modal = root.querySelector("#calEventModal");
  const errEl = root.querySelector("#calModalError");
  const evId  = modal.dataset.evId;
  const rentalRequestId = modal.dataset.rentalRequestId || "";
  const seriesId = modal.dataset.seriesId || "";
  if (!evId) return;

  if (!canManageCalendar) {
    const targetEvent = calendarEvents.find((ev) => ev.id === evId);
    if (!canEditCalendarEventForSession(targetEvent)) {
      showCalError(errEl, "You can only delete your own approved events.");
      return;
    }
    const confirmed = await openLinkedDeleteDialog({
      title: "Request event delete?",
      message: "This hides the event from your calendar now. Admin approval finalizes the delete.",
      confirmLabel: "Submit Delete",
      cancelLabel: "Cancel"
    });
    if (!confirmed) return;

    try {
      const token = currentAuthSession?.access_token || "";
      if (!token) throw new Error("Please sign in again before submitting.");
      const response = await fetch("/api/calendar-event-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ requestType: "delete", targetEventId: evId })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success === false) {
        throw new Error(body.error || "Could not submit delete request.");
      }
      calendarRequestNotice = "Event delete submitted for approval.";
      hasOwnedCalendarEvents = true;
      updateNavigationVisibility();
      modal.hidden = true;
      await renderCalendarPage();
    } catch (error) {
      showCalError(errEl, error.message || "Could not submit delete request.");
    }
    return;
  }

  let recurringScope = "this";
  if (seriesId) {
    const pickedScope = await openRecurringDeleteScopeDialog();
    if (!pickedScope) return;
    recurringScope = pickedScope;
  } else {
    const deleteEventConfirmed = await openLinkedDeleteDialog({
      title: "Delete calendar event?",
      message: "This will remove the event from the calendar.",
      confirmLabel: "Delete",
      cancelLabel: "Cancel"
    });
    if (!deleteEventConfirmed) return;
  }

  let deleteRentalToo = false;
  if (rentalRequestId) {
    deleteRentalToo = await openLinkedDeleteDialog({
      title: "Delete linked rental request too?",
      message: seriesId
        ? "Do you want to delete the selected linked bookings from the rentals page as well?"
        : "Do you want to delete this booking from the rentals page as well?",
      confirmLabel: "Yes",
      cancelLabel: "No"
    });
  }

  try {
    const token = currentAuthSession?.access_token || "";
    if (!token) throw new Error("Please sign in again before deleting.");
    const targetEvent = calendarEvents.find((ev) => ev.id === evId);
    const deleteIds = !seriesId
      ? [evId]
      : recurringScope === "all"
        ? calendarEvents
          .filter((ev) => parseSeriesToken(ev.createdBy) === seriesId)
          .map((ev) => ev.id)
        : recurringScope === "following" && targetEvent
          ? calendarEvents
            .filter((ev) => parseSeriesToken(ev.createdBy) === seriesId && isSameOrAfterFacilityDate(ev.startAt, targetEvent.startAt))
            .map((ev) => ev.id)
          : [evId];
    const deleteRentalIds = deleteRentalToo
      ? [...new Set(calendarEvents
        .filter((ev) => deleteIds.includes(ev.id))
        .map((ev) => ev.rentalRequestId)
        .filter(Boolean))]
      : [];

    for (const id of deleteIds) {
      const res   = await fetch("/api/events", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id })
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "Delete failed");
    }

    for (const linkedRentalId of deleteRentalIds) {
      const rentalRes = await fetch("/api/rental-reviews", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: linkedRentalId, deleteLinkedEvent: false })
      });
      const rentalBody = await rentalRes.json().catch(() => ({}));
      if (!rentalRes.ok || rentalBody.success === false) {
        throw new Error(rentalBody.error || "Event deleted, but linked rental could not be deleted.");
      }
    }

    modal.hidden = true;
    await renderCalendarPage();
  } catch (err) {
    showCalError(errEl, err.message || "Could not delete event.");
  }
}

function showCalError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = Number(statusCode) || 500;
  maybeRefreshForInvalidSession(error);
  return error;
}

function isInvalidSessionError(error) {
  const message = String(error?.message || error?.error_description || "").toLowerCase();
  const statusCode = Number(error?.statusCode || error?.status || 0);
  return statusCode === 401
    || message.includes("invalid session")
    || message.includes("invalid supabase session")
    || message.includes("missing session token")
    || message.includes("missing supabase session")
    || message.includes("jwt expired")
    || message.includes("refresh token");
}

function maybeRefreshForInvalidSession(error) {
  if (!isInvalidSessionError(error)) return false;
  scheduleInvalidSessionRefresh();
  return true;
}

function scheduleInvalidSessionRefresh() {
  if (invalidSessionRefreshTimer) return;

  const message = "Invalid session. Refreshing now...";
  try {
    sessionStorage.setItem(APP_INVALID_SESSION_REFRESH_KEY, "1");
  } catch {}

  showAppNotice(message, "Invalid Session");
  setAuthMessage(message, "error");

  invalidSessionRefreshTimer = window.setTimeout(() => {
    window.location.reload();
  }, 1100);
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
  const scheduledFor = row.scheduledFor || row.scheduled_for || channels.scheduledFor || "";
  const scheduledStatus = String(row.scheduledStatus ?? row.scheduled_status ?? channels.scheduledStatus ?? channels.scheduled_status ?? "").trim();
  const scheduledMessageId = String(row.scheduledMessageId ?? row.scheduled_message_id ?? channels.scheduledMessageId ?? channels.scheduled_message_id ?? "").trim();
  const dispatchId = String(row.dispatchId ?? row.dispatch_id ?? channels.dispatchId ?? channels.dispatch_id ?? row.id ?? "").trim();
  const canceledAt = row.canceledAt || row.canceled_at || channels.canceledAt || "";
  const sentAt = row.sentAt || row.sent_at || channels.sentAt || "";
  const isScheduled = Boolean(row.scheduled || channels.scheduled || ["scheduled", "processing", "canceled", "failed"].includes(scheduledStatus));
  const warnings = Array.isArray(row.warnings)
    ? row.warnings
    : Array.isArray(row.errorMessages)
      ? row.errorMessages
      : [];
  const statusLabel = (() => {
    if (scheduledStatus === "canceled") return `Canceled ${formatFacilityShortDateTime(canceledAt || scheduledFor)}`;
    if (scheduledStatus === "failed") return `Failed ${formatFacilityShortDateTime(scheduledFor)}`;
    if (scheduledStatus === "processing") return `Processing ${formatFacilityShortDateTime(scheduledFor)}`;
    if (scheduledStatus === "scheduled" || isScheduled) return `Scheduled ${formatFacilityShortDateTime(scheduledFor)}`;
    return `Text ${sentTextCount} · Email ${sentEmailCount} · In-App ${sentInAppCount}`;
  })();

  return {
    id: row.id || dispatchId || `msg-${Date.now()}`,
    dispatchId,
    scheduledMessageId,
    scheduledStatus,
    canceledAt,
    sentAt,
    title: row.title || "Message",
    message: row.message || "",
    channelsLabel: activeChannels.join(" + ") || "Unspecified",
    recipientsLabel: `${recipientCount} ${recipientCount === 1 ? "member" : "members"}`,
    statusLabel,
    warningsLabel: warnings.length ? `Warnings: ${warnings.join("; ")}` : "",
    createdAt: row.createdAt || row.created_at || new Date().toISOString(),
    scheduledFor,
    rawChannels: {
      text: Boolean(channels.text),
      email: Boolean(channels.email),
      inApp: Boolean(channels.inApp),
      scheduled: isScheduled,
      scheduledStatus
    },
    warnings,
    canCancelScheduled: Boolean(row.canCancelScheduled ?? row.can_cancel_scheduled ?? (scheduledMessageId && scheduledStatus === "scheduled")),
    canDeleteScheduled: Boolean(row.canDeleteScheduled ?? row.can_delete_scheduled ?? (scheduledMessageId && ["scheduled", "canceled", "failed"].includes(scheduledStatus)))
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

function stopHeaterEntriesRealtime() {
  if (heaterEntriesRealtimeRetryTimer) {
    window.clearTimeout(heaterEntriesRealtimeRetryTimer);
    heaterEntriesRealtimeRetryTimer = null;
  }

  if (heaterEntriesRealtimeChannel) {
    try {
      heaterEntriesRealtimeChannel.unsubscribe();
    } catch (error) {
      // Ignore unsubscribe failures during cleanup.
    }
    heaterEntriesRealtimeChannel = null;
  }
}

function scheduleHeaterEntriesRealtimeReconnect() {
  if (!currentAuthSession) return;
  if (heaterEntriesRealtimeRetryTimer) return;
  heaterEntriesRealtimeRetryTimer = window.setTimeout(() => {
    heaterEntriesRealtimeRetryTimer = null;
    void startHeaterEntriesRealtime();
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

async function startHeaterEntriesRealtime() {
  if (!currentAuthSession) return;
  stopHeaterEntriesRealtime();

  const client = await createSupabaseClient();
  if (!client) return;

  heaterEntriesRealtimeChannel = client
    .channel("heater-entries-live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "heater_use_entries" },
      () => {
        syncHeaterEntries({ rerender: true })
          .catch((error) => {
            console.warn("Could not sync heater entries realtime change.", error);
          });
      }
    )
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await syncHeaterEntries({ rerender: false })
          .catch((error) => {
            console.warn("Could not sync heater entries after realtime subscribe.", error);
          });
        return;
      }

      if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
        scheduleHeaterEntriesRealtimeReconnect();
      }
    });
}

async function syncHeaterEntries({ rerender = false } = {}) {
  if (heaterEntriesSyncInFlight) {
    heaterEntriesSyncPending = true;
    heaterEntriesSyncNeedsRender = heaterEntriesSyncNeedsRender || rerender;
    return;
  }

  heaterEntriesSyncInFlight = true;
  try {
    let shouldRerender = rerender;

    do {
      heaterEntriesSyncPending = false;
      shouldRerender = shouldRerender || heaterEntriesSyncNeedsRender;
      heaterEntriesSyncNeedsRender = false;

      const client = await createSupabaseClient();
      if (!client) return;

      const [heaterResult, heaterGroupResult] = await Promise.all([
        client
          .from("heater_use_entries_with_duration")
          .select("*")
          .order("start_at", { ascending: false, nullsFirst: false })
          .order("used_on", { ascending: false })
          .limit(500),
        client.from("heater_use_group_members").select("*")
      ]);

      if (heaterResult.error) throw heaterResult.error;

      const heaterGroupMap = (heaterGroupResult.data || []).reduce((map, row) => {
        const current = map.get(row.heater_use_entry_id) || [];
        current.push(row.account_member_id);
        map.set(row.heater_use_entry_id, current);
        return map;
      }, new Map());

      const previouslyActiveSystems = new Set(
        ["heat", "ac"].filter((systemType) => activeHeaterEntry(systemType) !== null)
      );

      heaterUseEntries = (heaterResult.data || []).map((row) => ({
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

      previouslyActiveSystems.forEach((systemType) => {
        if (activeHeaterEntry(systemType) === null) {
          markThermostatSystemOff(systemType);
          fetchThermostatStatus({ force: true }).catch(() => null);
        }
      });

      if (shouldRerender && appState.currentRoute === "heaterRecords") {
        render("heaterRecords");
      }

      shouldRerender = false;
    } while (heaterEntriesSyncPending);
  } finally {
    heaterEntriesSyncInFlight = false;
  }
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

  const initialRoute = requestedInitialRoute() || storedRefreshRoute();
  if (initialRoute) {
    appState.currentRoute = initialRoute;
  }

  showAppShell();
  appState.dataStatus = "loading";
  showRouteLoading(appState.currentRoute);

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
        .order("start_at", { ascending: false, nullsFirst: false })
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
      try {
        await refreshRentalReviewsBadge();
      } catch (rentalBadgeError) {
        console.warn("Could not load rental review count.", rentalBadgeError);
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
      await startHeaterEntriesRealtime();
    } catch (realtimeError) {
      console.warn("Could not start realtime sync.", realtimeError);
    }
    await refreshOwnedCalendarEventAvailability();
  } catch (error) {
    console.error("Supabase data load failed.", error);
    if (maybeRefreshForInvalidSession(error)) return false;
    clearLiveData();
    appState.dataStatus = "error";
    appState.dataError = error.message || "Data load failed.";
    refreshSessions();
    updateDrawerIdentity();
    showAuthGate(appState.dataError, "error");
    return false;
  }

  render(appState.currentRoute);
  showInvalidSessionRefreshReturnMessage();
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
    mailingAddress: row.mailing_address || "",
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
    mailingAddress: row.mailing_address || "",
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
    return "";
  }

  if (appState.dataStatus === "error") {
    return `<p class="data-source-note is-warning">Could not load data. ${escapeHtml(appState.dataError)}</p>`;
  }

  return "";
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
    refreshRentalReviewsBadge().catch((error) => {
      console.warn("Could not refresh rental review badge.", error);
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
    .filter((member) => !isKioskAccount(member) && !isRentalAccount(member));
}

function memberPickerOptions(source) {
  const hideFromNormalPickers = (member) => canonicalAccountType(member?.accountType) !== "Rental Account";
  const sortOnly = (members) => [...members].filter(hideFromNormalPickers).sort(sortMembers);
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
  input.dispatchEvent(new Event("change", { bubbles: true }));
  label.innerHTML = memberPickerLabel(member);
  button.classList.toggle("has-value", Boolean(member));
  if (inputId === "guestMemberSelect") renderRecentGuestWindowOptions();
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

function formatFacilityShortDateTime(value) {
  if (!value) return "Open";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
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

function facilityClockParts(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) {
    return { weekday: "", weekdayIndex: null, hour: 0, minute: 0 };
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});

  const weekdayIndexes = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = parts.hour === "24" ? 0 : Number(parts.hour || 0);
  const minute = Number(parts.minute || 0);
  return {
    weekday: parts.weekday || "",
    weekdayIndex: Object.prototype.hasOwnProperty.call(weekdayIndexes, parts.weekday) ? weekdayIndexes[parts.weekday] : null,
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0
  };
}

function facilityWeekdayIndex(date) {
  const parts = facilityClockParts(date);
  return parts.weekdayIndex ?? date.getDay();
}

function minuteOfDayFacility(date) {
  const parts = facilityClockParts(date);
  return (parts.hour * 60) + parts.minute;
}

function isOpenGymWindow(date) {
  const parts = facilityClockParts(date);
  const minutes = (parts.hour * 60) + parts.minute;
  const startsAt = (17 * 60) + 50;
  const endsAt = (20 * 60) + 10;

  return ["Tue", "Thu"].includes(parts.weekday) && minutes >= startsAt && minutes <= endsAt;
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
    ? { min: 60, max: 80 }
    : { min: 45, max: 80 };
}

function thermostatTemperatureChoices(systemType) {
  return normalizeThermostatSystemType(systemType) === "ac"
    ? [60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80]
    : [45, 50, 55, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80];
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
  const recordValue = Number(activeEntry?.targetTemperatureF);
  if (Number.isFinite(recordValue) && recordValue > 0) {
    return recordValue;
  }

  const liveValue = systemType === "ac" ? Number(item?.desiredCoolF) : Number(item?.desiredHeatF);
  if (Number.isFinite(liveValue) && liveValue > 0) {
    return liveValue;
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

function isLiveThermostatActive(systemType, item) {
  if (!item?.configured || item.error || item.stale) return false;
  if (systemType === "ac") return Boolean(item?.isCooling);
  if (systemType === "heat") return Boolean(item?.isHeating);
  return false;
}

function isLiveThermostatStateKnown(item) {
  return Boolean(thermostatStatus && item?.configured && !item.error && !item.stale);
}

function patchThermostatStatus(systemType, updates = {}) {
  const normalizedSystemType = normalizeThermostatSystemType(systemType);
  if (!normalizedSystemType || !thermostatStatus?.thermostats) return;

  const current = thermostatStatus.thermostats[normalizedSystemType] || {
    systemType: normalizedSystemType,
    configured: true
  };

  thermostatStatus = {
    ...thermostatStatus,
    thermostats: {
      ...thermostatStatus.thermostats,
      [normalizedSystemType]: {
        ...current,
        ...updates,
        systemType: normalizedSystemType,
        configured: current.configured !== false,
        error: "",
        stale: false,
        staleReason: ""
      }
    },
    fetchedAt: new Date().toISOString(),
    localOverride: true
  };
  thermostatStatusFetchedAt = Date.now();
}

function markThermostatSystemOff(systemType) {
  patchThermostatStatus(systemType, {
    hvacMode: "off",
    equipmentStatus: "",
    currentActivity: "Off",
    isCooling: false,
    isHeating: false,
    isFanRunning: false
  });
}

function markThermostatSystemOn(systemType, targetTemperatureF = null) {
  const normalizedSystemType = normalizeThermostatSystemType(systemType);
  if (!normalizedSystemType) return;

  const roundedTarget = Number.isFinite(Number(targetTemperatureF))
    ? Math.round(Number(targetTemperatureF))
    : null;
  const updates = {
    hvacMode: normalizedSystemType === "ac" ? "cool" : "heat",
    equipmentStatus: "",
    currentActivity: "Idle",
    isCooling: false,
    isHeating: false,
    isFanRunning: false
  };

  if (roundedTarget !== null) {
    updates[normalizedSystemType === "ac" ? "desiredCoolF" : "desiredHeatF"] = roundedTarget;
  }

  patchThermostatStatus(normalizedSystemType, updates);
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
  const isRecordActive = activeEntry != null && normalizeThermostatSystemType(activeEntry.systemType) === systemType;
  const isLiveActive = isLiveThermostatActive(systemType, item);

  if (isRecordActive || isLiveActive) {
    const activity = isLiveActive && item?.configured && !item.error
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
        <button class="thermostat-setpoint-button" data-change-thermostat-temp="${escapeAttribute(systemType)}" data-change-thermostat-entry-id="${escapeAttribute(activeEntry?.id || "")}" type="button"${disabledAttr}>
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
      <article class="is-disabled" aria-disabled="true">
        <span>${escapeHtml(label)}</span>
        <strong>Checking...</strong>
        <small>Waiting for live status</small>
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

  if (item.stale) {
    return `
      <article data-open-thermostat-system="${escapeAttribute(systemType)}" class="${systemEnabled ? "" : "is-disabled"}" role="button" tabindex="${systemEnabled ? "0" : "-1"}" aria-disabled="${systemEnabled ? "false" : "true"}">
        <span>${escapeHtml(label)}</span>
        <strong>Status stale</strong>
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
  const activeHeatEntry = activeHeaterEntry("heat");
  const activeAcEntry = activeHeaterEntry("ac");
  const room = firstConfiguredThermostat(status.heat, status.ac) || status.heat || status.ac || {};
  const isLoading = !thermostatStatus;
  const hasRoomData = Boolean(!isLoading && room?.configured && !room.error && !room.stale);
  const roomTitle = isLoading ? "Checking..." : (hasRoomData ? thermostatTempLabel(room.temperatureF) : "Status unavailable");
  const roomSubtitle = isLoading
    ? "Waiting for live status"
    : hasRoomData
    ? `Humidity ${thermostatPercentLabel(room.humidity)}`
    : "-";
  const roomMetrics = isLoading ? ["Air quality waiting", "Weather waiting"] : hasRoomData ? [
    thermostatAirQualityMetric(room),
    thermostatWeatherLabel(room.weather, room.humidity)
  ].filter(Boolean) : ["Air quality -", "-"];

  const refreshed = thermostatStatus?.fetchedAt ? `Updated ${formatShortDateTime(thermostatStatus.fetchedAt)}` : "";
  const systemCards = [
    renderThermostatSystemStatus("Heat", status.heat, activeHeatEntry),
    renderThermostatSystemStatus("AC", status.ac, activeAcEntry)
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
    <div class="thermostat-system-grid" aria-label="Heat and AC status">
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
  const pickerOrder = ["Account Manager", "Kiosk Account", "Special Access Account", "Active Membership", "Weight Room Only", "Open Gym Only", "Rental Account", "RESTRICTED ACCOUNT"];
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
  if (normalizedType === "Rental Account") return "Limited booking access for calendar, about, and My Events. No facility sign-in privileges.";
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
    fetchThermostatStatus().then(() => {
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
  let activeEntry = findActiveEntryByIdAndSystem(preferredEntryId, normalizedSystemType)
    || activeHeaterEntry(normalizedSystemType);

  if (!activeEntry) {
    await hydrateFromSupabase();
    activeEntry = findActiveEntryByIdAndSystem(preferredEntryId, normalizedSystemType)
      || activeHeaterEntry(normalizedSystemType);
  }

  if (!activeEntry) {
    if (normalizedSystemType) {
      const systemLabel = thermostatSystemLabel(normalizedSystemType);
      setThermostatActionFeedback("off", normalizedSystemType, `Turning ${systemLabel} off. This can take a moment.`);
      render("heaterRecords");
      await triggerHeaterOffSequence([], {
        systemType: normalizedSystemType,
        heaterUseEntryId: null,
        timerTriggered: false
      });
      markThermostatSystemOff(normalizedSystemType);
    }

    await hydrateFromSupabase();
    clearThermostatActionFeedback();
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
      markThermostatSystemOff(activeSystemType);
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

  markThermostatSystemOff(activeSystemType);
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

    markThermostatSystemOff(entry.systemType);
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

async function changeActiveThermostatTemperature(systemType = "", preferredEntryId = "") {
  const normalizedSystemType = systemType ? normalizeThermostatSystemType(systemType) : "";
  let activeEntry = findActiveEntryByIdAndSystem(preferredEntryId, normalizedSystemType)
    || activeHeaterEntry(normalizedSystemType);

  if (!activeEntry) {
    await hydrateFromSupabase();
    activeEntry = findActiveEntryByIdAndSystem(preferredEntryId, normalizedSystemType)
      || activeHeaterEntry(normalizedSystemType);
  }

  if (!activeEntry) {
    if (!normalizedSystemType) {
      clearThermostatActionFeedback();
      await fetchThermostatStatus({ force: true }).catch(() => null);
      if (appState.currentRoute === "heaterRecords") render("heaterRecords");
      return;
    }

    const nextTemp = await openThermostatTemperatureDialog({
      systemType: normalizedSystemType,
      targetTemperatureF: thermostatSetPointForSystem(
        normalizedSystemType,
        thermostatStatus?.thermostats?.[normalizedSystemType] || null,
        null
      )
    });
    if (nextTemp === null) return;

    const allowedRange = thermostatTemperatureRange(normalizedSystemType);
    if (!Number.isFinite(nextTemp) || nextTemp < allowedRange.min || nextTemp > allowedRange.max) {
      showDetailActionMessage(`Enter a temperature between ${allowedRange.min} and ${allowedRange.max}.`);
      return;
    }

    setThermostatActionFeedback("temp", normalizedSystemType, `Updating ${thermostatSystemLabel(normalizedSystemType)} to ${Math.round(nextTemp)}°F.`);
    render("heaterRecords");

    await triggerHeaterOnSequence([], {
      systemType: normalizedSystemType,
      targetTemperatureF: Math.round(nextTemp),
      silent: true
    });

    markThermostatSystemOn(normalizedSystemType, nextTemp);
    await hydrateFromSupabase();
    clearThermostatActionFeedback();
    if (appState.currentRoute === "heaterRecords") render("heaterRecords");
    return;
  }

  const nextTemp = await openThermostatTemperatureDialog(activeEntry);
  if (nextTemp === null) return;
  const activeSystemType = normalizeThermostatSystemType(activeEntry.systemType);
  const allowedRange = thermostatTemperatureRange(activeSystemType);

  if (!Number.isFinite(nextTemp) || nextTemp < allowedRange.min || nextTemp > allowedRange.max) {
    showDetailActionMessage(`Enter a temperature between ${allowedRange.min} and ${allowedRange.max}.`);
    return;
  }

  const client = await createSupabaseClient();
  if (!client) {
    showDetailActionMessage("App data is not available.");
    return;
  }

  setThermostatActionFeedback("temp", activeSystemType, `Updating ${thermostatSystemLabel(activeSystemType)} to ${Math.round(nextTemp)}°F.`);
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
    systemType: activeSystemType,
    targetTemperatureF: Math.round(nextTemp),
    silent: true
  });

  markThermostatSystemOn(activeSystemType, nextTemp);
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

  const members = accountMembers
    .filter((member) => !isRentalAccount(member))
    .sort(sortMembers);
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

async function fetchAutomatedMessagePreview(payload) {
  const token = currentAuthSession?.access_token || "";
  if (!token) throw new Error("Log in again before confirming this automation.");

  const response = await fetch("/api/communication-preview", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "Could not build email preview.");
  }
  return body.preview;
}

async function confirmAutomatedEmailBeforeSave(payload, options = {}) {
  try {
    const preview = await fetchAutomatedMessagePreview(payload);
    if (!preview?.willSend) return true;
    return showAutomationConfirmDialog(preview, options);
  } catch (error) {
    showAppNotice(error.message || "Could not verify the automated email. No changes were saved.");
    return false;
  }
}

function showAutomationConfirmDialog(preview, options = {}) {
  const existing = document.querySelector(".communication-preview-overlay");
  if (existing) existing.remove();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "communication-preview-overlay";
    overlay.innerHTML = `
      <section class="communication-preview-dialog automation-confirm-dialog" role="dialog" aria-modal="true" aria-label="Confirm automated email">
        <header>
          <div>
            <p class="eyebrow">Automation Check</p>
            <h3>${escapeHtml(options.title || "Continue with this save?")}</h3>
          </div>
        </header>
        <div class="automation-confirm-banner">
          <span class="admin-delivery-check" aria-hidden="true">&#10003;</span>
          <div>
            <strong>Email will be sent</strong>
            <p>${escapeHtml(options.message || "This admin action has an automated email scheduled after save.")}</p>
          </div>
        </div>
        <div class="communication-preview-meta">
          <span><strong>To</strong>${escapeHtml(preview?.to || "No recipient on file")}</span>
          <span><strong>Subject</strong>${escapeHtml(preview?.subject || "Email Preview")}</span>
        </div>
        <label class="automation-confirm-checkbox">
          <input class="automation-confirm-check" type="checkbox" />
          <span>Yes, send this automated email when I save.</span>
        </label>
        <button class="admin-message-more automation-preview-toggle" type="button">More Info</button>
        <div class="automation-preview-panel" hidden>
          <iframe class="communication-preview-frame" title="Email preview"></iframe>
          <details class="communication-preview-text">
            <summary>Plain text version</summary>
            <pre>${escapeHtml(preview?.text || "")}</pre>
          </details>
        </div>
        <footer class="communication-preview-actions">
          <button class="communication-preview-cancel" type="button">Cancel</button>
          <button class="communication-preview-confirm" type="button" disabled>${escapeHtml(options.confirmLabel || "Save & Send Email")}</button>
        </footer>
      </section>
    `;

    const close = (confirmed) => {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(Boolean(confirmed));
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") close(false);
    };

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
    const checkbox = overlay.querySelector(".automation-confirm-check");
    const confirmButton = overlay.querySelector(".communication-preview-confirm");
    checkbox?.addEventListener("change", () => {
      if (confirmButton) confirmButton.disabled = !checkbox.checked;
    });
    overlay.querySelector(".communication-preview-cancel")?.addEventListener("click", () => close(false));
    confirmButton?.addEventListener("click", () => close(true));
    overlay.querySelector(".automation-preview-toggle")?.addEventListener("click", (event) => {
      const panel = overlay.querySelector(".automation-preview-panel");
      if (!panel) return;
      const nextHidden = !panel.hidden;
      panel.hidden = nextHidden;
      event.currentTarget.textContent = nextHidden ? "More Info" : "Hide Info";
    });
    document.addEventListener("keydown", onKeydown);
    document.body.appendChild(overlay);

    const frame = overlay.querySelector(".communication-preview-frame");
    if (frame) {
      frame.srcdoc = preview?.html || `<pre>${escapeHtml(preview?.text || "")}</pre>`;
    }
  });
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

  document.querySelectorAll("[data-change-thermostat-temp]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const systemType = String(event.currentTarget?.dataset?.changeThermostatTemp || "").trim();
      const entryId = String(event.currentTarget?.dataset?.changeThermostatEntryId || "").trim();
      changeActiveThermostatTemperature(systemType, entryId).catch((error) => {
        clearThermostatActionFeedback();
        if (appState.currentRoute === "heaterRecords") render("heaterRecords");
        showDetailActionMessage(error.message || "Could not change thermostat temperature.");
      });
    });
  });

  document.querySelectorAll("[data-turn-thermostat-off]").forEach((button) => {
    button.addEventListener("click", (event) => {
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
  setThermostatFormSystemValue(selectedSystem);

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

  if (!input || !dateTimeIn) return;

  dateTimeIn.value = formatDateTime(new Date());
  setMemberPickerValue(input.id, input.value);
  renderRecentGuestWindowOptions();
  startRecentGuestWindowTimer();
}

function normalizeGuestDayName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function accountIdForMemberId(memberId) {
  return findMember(memberId)?.accountId || "";
}

function memberIdsForAccountId(accountId) {
  if (!accountId) return new Set();
  const members = globalMemberDirectory.length ? globalMemberDirectory : accountMembers;
  return new Set(members.filter((member) => member.accountId === accountId).map((member) => member.id));
}

function recentDayPassGuestWindows(referenceDate = new Date(), sponsorMemberId = "") {
  const nowMs = referenceDate.getTime();
  const byGuest = new Map();
  const sponsorAccountId = accountIdForMemberId(sponsorMemberId);
  const sameAccountMemberIds = memberIdsForAccountId(sponsorAccountId);

  timesheetEntries
    .filter((entry) => (
      entry.memberOrGuest === "Guest"
      && entry.dayPassOrOpenGym === "Day Pass"
      && entry.guestName
      && entry.signedInAt
      && (!sponsorAccountId || sameAccountMemberIds.has(entry.memberEnteredWithId))
    ))
    .forEach((entry) => {
      const signedInMs = new Date(entry.signedInAt).getTime();
      if (!Number.isFinite(signedInMs)) return;
      const expiresAtMs = signedInMs + GUEST_DAY_WINDOW_MS;
      if (expiresAtMs <= nowMs) return;

      const name = String(entry.guestName || "").trim().replace(/\s+/g, " ");
      const key = normalizeGuestDayName(name);
      if (!key) return;

      const existing = byGuest.get(key);
      if (!existing || signedInMs > existing.signedInMs) {
        byGuest.set(key, { name, signedInMs, expiresAtMs });
      }
    });

  return [...byGuest.values()]
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs)
    .slice(0, 30);
}

function formatGuestWindowRemaining(expiresAtMs, referenceDate = new Date()) {
  const remainingMs = Math.max(0, expiresAtMs - referenceDate.getTime());
  const totalMinutes = Math.ceil(remainingMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m left`;
  if (minutes === 0) return `${hours}h left`;
  return `${hours}h ${minutes}m left`;
}

function renderRecentGuestWindowOptions() {
  const datalist = document.getElementById("recentGuestNames");
  const list = document.getElementById("recentGuestWindowList");
  if (!datalist && !list) return;

  const now = new Date();
  const sponsorMemberId = String(document.getElementById("guestMemberSelect")?.value || "").trim();
  const windows = recentDayPassGuestWindows(now, sponsorMemberId);

  if (datalist) {
    datalist.innerHTML = windows
      .map((guest) => `<option value="${escapeAttribute(guest.name)}" label="${escapeAttribute(formatGuestWindowRemaining(guest.expiresAtMs, now))}"></option>`)
      .join("");
  }

  if (!list) return;
  list.hidden = windows.length === 0;
  if (!windows.length) {
    list.innerHTML = "";
    return;
  }

  const recentGuestNote = sponsorMemberId
    ? "Recent Day Pass guests stay reusable for 24 hours under the same account without using another free guest day or adding another $0.25 charge."
    : "Select the member entered with to narrow recent Day Pass guests to that account. Reuse lasts 24 hours under the same account.";

  list.innerHTML = `
    <p class="recent-guest-window-note">${escapeHtml(recentGuestNote)}</p>
    <div class="recent-guest-window-items">
      ${windows.map((guest) => `
        <button class="recent-guest-chip" type="button" data-recent-guest="${escapeAttribute(guest.name)}">
          <span class="recent-guest-name">${escapeHtml(guest.name)}</span>
          <span class="recent-guest-time">${escapeHtml(formatGuestWindowRemaining(guest.expiresAtMs, now))}</span>
        </button>
      `).join("")}
    </div>
  `;

  list.querySelectorAll("[data-recent-guest]").forEach((button) => {
    button.addEventListener("click", () => {
      const guestNameInput = document.getElementById("guestNameInput");
      if (!guestNameInput) return;
      guestNameInput.value = button.dataset.recentGuest || "";
      guestNameInput.focus();
    });
  });
}

function startRecentGuestWindowTimer() {
  if (recentGuestWindowTimer) window.clearInterval(recentGuestWindowTimer);
  recentGuestWindowTimer = window.setInterval(() => {
    if (!document.getElementById("recentGuestWindowList")) {
      window.clearInterval(recentGuestWindowTimer);
      recentGuestWindowTimer = null;
      return;
    }
    renderRecentGuestWindowOptions();
  }, 60000);
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

function setThermostatFormSystemValue(systemType) {
  const normalizedSystemType = normalizeThermostatSystemType(systemType);
  const input = document.getElementById("thermostatSystemValue");
  if (input) {
    input.value = normalizedSystemType;
  }
  appState.pendingThermostatSystem = normalizedSystemType;
  return normalizedSystemType;
}

function selectedThermostatFormSystem(form = document) {
  const selectedValue = String(form?.querySelector?.('[aria-label="Thermostat system"] .segment.is-selected')?.dataset?.thermostatSystem || "").trim();
  if (selectedValue === "heat" || selectedValue === "ac") {
    setThermostatFormSystemValue(selectedValue);
    return selectedValue;
  }

  const explicitValue = String(form?.querySelector?.("#thermostatSystemValue")?.value || "").trim();
  if (explicitValue === "heat" || explicitValue === "ac") {
    return explicitValue;
  }

  return appState.pendingThermostatSystem === "ac" ? "ac" : "heat";
}

function updateHeaterGroupPayFields(selectedButton) {
  const systemType = selectedThermostatFormSystem(document.querySelector(".heater-use-screen") || document);
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
  setThermostatFormSystemValue(systemType);
  const isAc = systemType === "ac";
  const targetTemp = document.getElementById("thermostatTargetTemp");
  const costCopy = document.getElementById("thermostatCostCopy");
  const groupPayField = document.querySelector('.heater-use-screen [aria-label="Group pay"]')?.closest(".segmented-field");
  const heaterPinField = document.querySelector(".heater-pin-field");
  const allowedRange = thermostatTemperatureRange(systemType);

  if (targetTemp) {
    const previousValue = Number(targetTemp.value);
    targetTemp.replaceChildren(...thermostatTemperatureChoices(systemType).map((value) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `${value}°F`;
      return option;
    }));
    targetTemp.value = Number.isFinite(previousValue) && previousValue >= allowedRange.min && previousValue <= allowedRange.max
      ? String(previousValue)
      : (isAc ? "66" : "74");
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
    heaterPinField.hidden = false;
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

  const weekday = facilityWeekdayIndex(signedInAt);
  const allowedDays = Array.isArray(policy.allowedDays) ? policy.allowedDays : [];
  if (allowedDays.length && !allowedDays.includes(weekday)) {
    return { allowed: false, reason: `${type} cannot sign in on this day.` };
  }

  const nowMinutes = minuteOfDayFacility(signedInAt);
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

  const systemType = selectedThermostatFormSystem(form);
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

  if (groupPayValue === "N" && !/^\d{4}$/.test(heaterPin)) {
    showDetailActionMessage(`Enter the 4-digit ${thermostatSystemLabel(systemType)} PIN.`);
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

    if (!groupPay && responsibleMemberId) {
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
      markThermostatSystemOn(systemType, targetTemperatureF);
    } else if (turnHeaterOn === "Off") {
      const smsRecipients = groupPay ? multiResponsibleMemberIds : [singleResponsibleMemberId];
      await triggerHeaterOffSequence(smsRecipients, {
        systemType,
        heaterUseEntryId: createdEntry?.id || null,
        timerTriggered: false
      }).catch((sequenceError) => {
        console.warn("Heater off sequence failed.", sequenceError);
      });
      markThermostatSystemOff(systemType);
    }

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
  stopHeaterEntriesRealtime();
  try {
    sessionStorage.removeItem(APP_REFRESH_ROUTE_KEY);
  } catch {}
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
  if (appState.dataStatus === "loading") {
    const pendingRouteName = routes[routeName] ? routeName : "currentlySignedIn";
    appState.currentRoute = pendingRouteName;
    rememberRefreshRoute(pendingRouteName);
    showRouteLoading(pendingRouteName);
    return;
  }

  let resolvedRouteName = routeName;

  if (isKioskModeSession(appUserSession) && !kioskAllowedRoutes.has(resolvedRouteName)) {
    resolvedRouteName = "currentlySignedIn";
  }

  if (isRentalAccount(appUserSession) && !rentalAccountAllowedRoutes.has(resolvedRouteName)) {
    resolvedRouteName = canViewCalendarRoute(appUserSession) ? "calendar" : "myAccount";
  }

  if (accountManagerOnlyRoutes.has(resolvedRouteName) && !isAccountManager(appUserSession)) {
    resolvedRouteName = "myAccount";
  }

  if (resolvedRouteName === "calendar" && !canViewCalendarRoute(appUserSession)) {
    resolvedRouteName = "myAccount";
  }

  if (resolvedRouteName === "myEvents" && !canViewMyEventsRoute(appUserSession)) {
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
  rememberRefreshRoute(resolvedRouteName);
  const renderSequence = ++routeRenderSequence;

  const backRoute = Boolean(route.formRoute || route.detailRoute);
  const activeRouteName = resolvedRouteName === "accountDetails" ? appState.detailReturnRoute : resolvedRouteName;

  screenTitle.textContent = route.title;
  appShell.classList.toggle("is-form-route", Boolean(route.formRoute));
  appShell.classList.toggle("is-detail-route", Boolean(route.detailRoute));
  navControl.classList.toggle("is-back", backRoute);
  navControl.setAttribute("aria-label", backRoute ? "Go back" : "Open menu");

  resetScrollTop();
  setRouteViewPending(true);

  view.innerHTML = "";
  view.appendChild(template.content.cloneNode(true));

  navItems.forEach((item) => {
    item.classList.toggle("is-active", item.dataset.route === activeRouteName);
  });

  drawerItems.forEach((item) => {
    item.classList.toggle("is-active", item.dataset.route === activeRouteName);
  });

  let afterRenderResult;
  try {
    afterRenderResult = route.afterRender?.();
  } catch (error) {
    console.error(`Route render failed for ${resolvedRouteName}.`, error);
    renderRouteLoadError(route, error);
  }

  resetScrollTop();
  populateMemberSignIn();
  populateGuestSignIn();
  bindMemberPickers();
  bindRouteActions();

  if (afterRenderResult && typeof afterRenderResult.then === "function") {
    Promise.resolve(afterRenderResult)
      .catch((error) => {
        console.error(`Route render failed for ${resolvedRouteName}.`, error);
        if (renderSequence === routeRenderSequence) {
          renderRouteLoadError(route, error);
        }
      })
      .finally(() => {
        if (renderSequence === routeRenderSequence) {
          setRouteViewPending(false);
          resetScrollTop();
        }
      });
  } else {
    setRouteViewPending(false);
  }
}

function navigateTo(routeName) {
  render(routeName);
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
    if (maybeRefreshForInvalidSession(error)) return;
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
