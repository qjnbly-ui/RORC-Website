(function() {
  const form = document.getElementById("membershipSignupForm");
  if (!form) return;

  const totalSteps = 5;
  const urlParams = new URLSearchParams(window.location.search);
  const inviteToken = String(urlParams.get("invite") || "").trim();
  const allowedPlanIds = new Set(["open_gym", "weight_room", "full_facility", "full_facility_wifi"]);
  let step = 0;
  let maxStepReached = 0;
  let inviteMode = false;
  let inviteLoadError = "";
  let contractReadUnlocked = false;

  function byId(id) {
    return document.getElementById(id);
  }

  function setResult(message, tone = "default") {
    const result = byId("signupResult");
    if (!result) return;
    result.textContent = message;
    result.dataset.tone = tone;
  }

  function setStep(nextStep) {
    step = Math.max(0, Math.min(totalSteps - 1, nextStep));

    document.querySelectorAll(".signup-step").forEach((section) => {
      const isActive = Number(section.dataset.step) === step;
      section.classList.toggle("is-active", isActive);
      section.hidden = !isActive;
    });

    document.querySelectorAll("[data-progress-step]").forEach((item) => {
      const itemStep = Number(item.dataset.progressStep);
      const isAvailable = itemStep <= maxStepReached;
      item.classList.toggle("is-active", itemStep === step);
      item.classList.toggle("is-complete", itemStep < maxStepReached && itemStep !== step);
      item.classList.toggle("is-available", isAvailable);
      item.classList.toggle("is-locked", !isAvailable);
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", isAvailable ? "0" : "-1");
      item.setAttribute("aria-current", itemStep === step ? "step" : "false");
      item.setAttribute("aria-disabled", isAvailable ? "false" : "true");
    });

    byId("signupBack").disabled = step === 0;
    byId("signupNext").hidden = step === totalSteps - 1;
    byId("signupSubmit").hidden = step !== totalSteps - 1;
    byId("signupNext").disabled = Boolean(inviteLoadError) || (step === 3 && !contractReadUnlocked);
    setResult("");
    syncContractReadState();
  }

  function validateCurrentStep() {
    const section = document.querySelector(`.signup-step[data-step="${step}"]`);
    if (!section) return true;

    const invalid = [...section.querySelectorAll("input, select, textarea")]
      .find((input) => !input.checkValidity());

    if (invalid) {
      invalid.reportValidity();
      return false;
    }

    if (step === 0 && !inviteMode && !byId("membershipPlan").value) {
      setResult("Select a membership plan.", "error");
      return false;
    }

    if (step === 2 && !inviteMode) {
      const memberValidation = validateAccountUsers();
      if (!memberValidation.valid) {
        setResult(memberValidation.message, "error");
        memberValidation.input?.focus();
        return false;
      }
    }

    if (step === 3 && !contractReadUnlocked) {
      setResult("Scroll through the full contract before acknowledging it.", "error");
      byId("contractScrollBox")?.focus();
      return false;
    }

    if (step === totalSteps - 1) {
      const signature = stringValue(byId("signatureName")?.value).toLowerCase();
      const primaryName = stringValue(byId("primaryName")?.value).toLowerCase();
      if (signature !== primaryName) {
        setResult("Typed signature must match the primary member name.", "error");
        return false;
      }

      if (byId("questionsOrConcerns")?.checked) {
        setResult("Questions or concerns must be resolved before accepting the contract.", "error");
        return false;
      }

      const password = stringValue(byId("primaryPassword")?.value);
      const passwordConfirm = stringValue(byId("primaryPasswordConfirm")?.value);
      if (password.length < 8) {
        setResult("Create a login password with at least 8 characters.", "error");
        byId("primaryPassword")?.focus();
        return false;
      }
      if (password !== passwordConfirm) {
        setResult("Login passwords do not match.", "error");
        byId("primaryPasswordConfirm")?.focus();
        return false;
      }
    }

    return true;
  }

  function selectPlan(planId) {
    const selectedPlan = allowedPlanIds.has(planId) ? planId : "full_facility";
    byId("membershipPlan").value = selectedPlan;
    document.querySelectorAll("[data-plan]").forEach((button) => {
      button.classList.toggle("is-selected", button.dataset.plan === selectedPlan);
    });
  }

  function addHouseholdMember() {
    const list = byId("householdMembers");
    const index = list.querySelectorAll(".signup-member-card").length + 1;
    const card = document.createElement("section");
    card.className = "signup-member-card";
    card.innerHTML = `
      <header>
        <h3>Account User ${index}</h3>
        <button class="signup-remove-member" type="button">Remove</button>
      </header>
      <div class="signup-field-grid">
        <label>
          <span>Full Legal Name</span>
          <input data-member-field="name" type="text" />
        </label>
        <label>
          <span>Date of Birth</span>
          <input data-member-field="dateOfBirth" type="date" />
        </label>
        <label>
          <span>Relationship</span>
          <input data-member-field="relationship" type="text" placeholder="Spouse, child, dependent, household member" />
        </label>
        <label>
          <span>Email, required for 13+ unless phone is provided</span>
          <input data-member-field="email" type="email" />
        </label>
        <label>
          <span>Phone, required for 13+ unless email is provided</span>
          <input data-member-field="phone" type="tel" />
        </label>
      </div>
    `;

    card.querySelector(".signup-remove-member").addEventListener("click", () => {
      card.remove();
      renumberHouseholdMembers();
      syncConditionalContractApplicability();
    });

    list.appendChild(card);
    syncConditionalContractApplicability();
  }

  function renumberHouseholdMembers() {
    document.querySelectorAll(".signup-member-card h3").forEach((heading, index) => {
      heading.textContent = `Account User ${index + 1}`;
    });
  }

  function collectHouseholdMembers() {
    return [...document.querySelectorAll(".signup-member-card")].map((card) => ({
      name: stringValue(card.querySelector('[data-member-field="name"]')?.value),
      dateOfBirth: stringValue(card.querySelector('[data-member-field="dateOfBirth"]')?.value),
      relationship: stringValue(card.querySelector('[data-member-field="relationship"]')?.value),
      email: stringValue(card.querySelector('[data-member-field="email"]')?.value),
      phone: stringValue(card.querySelector('[data-member-field="phone"]')?.value),
      canAccessIndependently: !isUnder13(stringValue(card.querySelector('[data-member-field="dateOfBirth"]')?.value))
    })).filter((member) => member.name);
  }

  function validateAccountUsers() {
    const cards = [...document.querySelectorAll(".signup-member-card")];
    const primaryDob = stringValue(byId("primaryDob")?.value);
    let totalUsers = 1;
    let over18Count = primaryDob && isAtLeast18(primaryDob) ? 1 : 0;

    for (const card of cards) {
      const nameInput = card.querySelector('[data-member-field="name"]');
      const dobInput = card.querySelector('[data-member-field="dateOfBirth"]');
      const emailInput = card.querySelector('[data-member-field="email"]');
      const phoneInput = card.querySelector('[data-member-field="phone"]');
      const name = stringValue(nameInput?.value);
      const dateOfBirth = stringValue(dobInput?.value);
      const email = stringValue(emailInput?.value);
      const phone = stringValue(phoneInput?.value);

      if (!name && !dateOfBirth && !email && !phone) continue;

      totalUsers += 1;
      if (!name) return { valid: false, message: "Each account user needs a legal name.", input: nameInput };
      if (!dateOfBirth) return { valid: false, message: `${name} needs a date of birth.`, input: dobInput };
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { valid: false, message: `Enter a valid email for ${name}.`, input: emailInput };
      }

      if (!isUnder13(dateOfBirth) && !email && !phone) {
        return { valid: false, message: `${name} is 13 or older and needs an email or phone so we can send the contract invite.`, input: emailInput };
      }

      if (isAtLeast18(dateOfBirth)) over18Count += 1;
    }

    if (totalUsers > 5) {
      return { valid: false, message: "Accounts can have a maximum of 5 users, including pending invites." };
    }

    if (over18Count > 2) {
      return { valid: false, message: "Accounts can have a maximum of 2 users over 18, including pending invites." };
    }

    return { valid: true };
  }

  function collectAcknowledgements() {
    return [...document.querySelectorAll("[data-ack]")].reduce((values, input) => {
      values[input.dataset.ack] = Boolean(input.checked);
      return values;
    }, {});
  }

  function getGuestEntryChoice() {
    const selected = document.querySelector('input[name="allowGuestEntry"]:checked');
    if (selected) return selected.value;
    return document.querySelector('input[name="allowGuestEntry"]') ? "" : "no";
  }

  function getHeaterAccessChoice() {
    const selected = document.querySelector('input[name="allowHeaterUse"]:checked');
    if (selected) return selected.value;
    return document.querySelector('input[name="allowHeaterUse"]') ? "" : "no";
  }

  function syncConditionalContractApplicability() {
    const members = collectHouseholdMembers();
    const hasAdditionalUsers = members.length > 0;
    const hasUnder13Users = members.some((member) => member.dateOfBirth && isUnder13(member.dateOfBirth));
    const familyNote = byId("familyMembershipApplicability");
    const minorNote = byId("minorResponsibilityApplicability");

    if (familyNote) {
      familyNote.textContent = inviteMode
        ? "This invite is only for your own contract, so household/family membership terms are informational unless the account owner adds users."
        : hasAdditionalUsers
          ? "Additional account users are listed, so the household/family membership terms apply to this signup."
          : "No additional account users are currently listed, so this household/family membership section is informational unless users are added later.";
    }

    if (minorNote) {
      minorNote.textContent = hasUnder13Users
        ? "Children under 13 are listed on this signup, so the parental acknowledgement below applies."
        : "No children under 13 are currently listed, so this parental acknowledgement is informational unless under-13 users are added later.";
    }
  }

  function syncHeaterDependentAcknowledgements() {
    const heaterAccess = getHeaterAccessChoice();
    const isHeaterAllowed = heaterAccess === "yes";
    const isHeaterDeclined = heaterAccess === "no";
    const copy = {
      groupPayFee: {
        applies: "I acknowledge the group pay instructions and the $5 fee associated with incorrect use of group pay.",
        notApplicable: "This doesn't apply to me because I selected to not have access to the heater."
      },
      heaterPenalty: {
        applies: "I acknowledge the standard penalty related to improper heater use is $50.",
        notApplicable: "This doesn't apply to me because I selected to not have access to the heater."
      }
    };

    Object.entries(copy).forEach(([key, text]) => {
      const input = document.querySelector(`[data-ack="${key}"]`);
      const label = input?.closest("label");
      const textNode = label?.querySelector(`[data-heater-dependent-copy="${key}"]`);
      if (!input || !label || !textNode) return;

      if (isHeaterDeclined) {
        input.checked = true;
        input.disabled = true;
        input.required = false;
        input.dataset.autoFilled = "heater-no";
        textNode.textContent = text.notApplicable;
        label.classList.add("is-auto-filled");
        return;
      }

      input.disabled = !isHeaterAllowed;
      input.required = isHeaterAllowed;
      if (input.dataset.autoFilled === "heater-no") {
        input.checked = false;
        delete input.dataset.autoFilled;
      }
      textNode.textContent = text.applies;
      label.classList.remove("is-auto-filled");
    });
  }

  function collectPayload() {
    return {
      inviteToken,
      planId: byId("membershipPlan").value,
      primary: {
        name: stringValue(byId("primaryName")?.value),
        email: stringValue(byId("primaryEmail")?.value),
        phone: stringValue(byId("primaryPhone")?.value),
        dateOfBirth: stringValue(byId("primaryDob")?.value),
        address: stringValue(byId("primaryAddress")?.value),
        accessPin: stringValue(byId("primaryPin")?.value),
        password: stringValue(byId("primaryPassword")?.value),
        canAccessIndependently: true
      },
      householdMembers: collectHouseholdMembers(),
      permissions: {
        allowGuestEntry: getGuestEntryChoice() === "yes",
        allowHeaterUse: getHeaterAccessChoice() === "yes"
      },
      acknowledgements: collectAcknowledgements(),
      signature: {
        typedName: stringValue(byId("signatureName")?.value),
        signedDate: stringValue(byId("signatureDate")?.value),
        questionsOrConcerns: Boolean(byId("questionsOrConcerns")?.checked)
      },
      contract: {
        version: "RORC Basic Membership Contract 2026-05-19",
        readRequired: true,
        fullContractDisplayed: true,
        contractPhotosDisplayed: true
      }
    };
  }

  async function signInCreatedUser() {
    if (!window.RORC_SUPABASE?.getClient) {
      return false;
    }

    const email = stringValue(byId("primaryEmail")?.value).toLowerCase();
    const password = stringValue(byId("primaryPassword")?.value);
    if (!email || !password) return false;

    const client = await window.RORC_SUPABASE.getClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      console.warn("Could not sign in new member before redirect.", error);
      return false;
    }

    return true;
  }

  function syncContractReadState() {
    const scrollBox = byId("contractScrollBox");
    const status = byId("contractReadStatus");
    if (!scrollBox || !status) return;

    const isContractStepVisible = step === 3 && !scrollBox.closest("[hidden]");
    const reachedBottom = isContractStepVisible
      && scrollBox.scrollHeight > 0
      && scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight <= 12;
    if (reachedBottom) {
      contractReadUnlocked = true;
    }

    status.classList.toggle("is-complete", contractReadUnlocked);
    status.textContent = contractReadUnlocked
      ? "Full contract reviewed. Complete each section acknowledgement before continuing."
      : "Scroll to the bottom of the contract before continuing.";

    const nextButton = byId("signupNext");
    if (nextButton && step === 3) {
      nextButton.disabled = !contractReadUnlocked;
    }
  }

  async function submitSignup(event) {
    event.preventDefault();
    if (!validateCurrentStep()) return;

    if (step !== totalSteps - 1) {
      maxStepReached = Math.max(maxStepReached, step + 1);
      setStep(step + 1);
      return;
    }

    const submitButton = byId("signupSubmit");
    submitButton.disabled = true;
    submitButton.textContent = "Submitting...";
    setResult("Creating your membership account...", "default");

    try {
      const response = await fetch("/api/membership-signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(collectPayload())
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok || body.success === false) {
        throw new Error(body.error || "Could not submit membership signup.");
      }

      if (body.checkoutUrl) {
        setResult("Opening secure Stripe checkout...", "success");
        await signInCreatedUser();
        window.location.href = body.checkoutUrl;
        return;
      }

      if (body.loginUrl) {
        setResult("Contract accepted. Opening dashboard...", "success");
        const signedIn = await signInCreatedUser();
        window.location.href = signedIn ? "/member-dashboard/?signup=pending_review" : body.loginUrl;
        return;
      }

      setResult(inviteMode
        ? "Contract received. Your account is pending RORC admin approval."
        : "Signup received. Your account is pending RORC admin approval.",
        "success"
      );
    } catch (error) {
      setResult(error.message || "Could not submit membership signup.", "error");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Submit & Continue To Checkout";
    }
  }

  async function loadInvitation() {
    if (!inviteToken) return true;

    setResult("Loading account invite...");

    try {
      const response = await fetch(`/api/account-invite?token=${encodeURIComponent(inviteToken)}`);
      const body = await response.json().catch(() => ({}));

      if (!response.ok || body.success === false) {
        throw new Error(body.error || "Could not load account invite.");
      }

      const invitation = body.invitation || {};
      inviteMode = true;

      byId("primaryName").value = invitation.name || "";
      byId("primaryEmail").value = invitation.email || "";
      byId("primaryPhone").value = invitation.phone || "";
      byId("primaryDob").value = invitation.dateOfBirth || "";
      byId("membershipPlan").value = "";

      if (invitation.email) {
        byId("primaryEmail").readOnly = true;
      }

      const planStep = document.querySelector('.signup-step[data-step="0"]');
      if (planStep) {
        planStep.innerHTML = `
          <h2>Accept Account Invite</h2>
          <input id="membershipPlan" type="hidden" value="" />
          <p>You were invited to join account <strong>${escapeHtml(invitation.accountNumber || "RORC")}</strong>.</p>
          <p>This signup will collect your contract acceptance and create your login. It will not create a new billing account or start a separate Stripe checkout.</p>
        `;
      }

      const usersStep = document.querySelector('.signup-step[data-step="2"]');
      if (usersStep) {
        usersStep.innerHTML = `
          <h2>Account Users</h2>
          <p>This invite is only for your own contract and login. Additional users must be added by the account owner.</p>
        `;
      }

      const pageTitle = document.querySelector(".signup-hero h1");
      if (pageTitle) {
        pageTitle.textContent = "Accept Membership Invite";
      }

      const firstProgressStep = document.querySelector('[data-progress-step="0"]');
      if (firstProgressStep) {
        firstProgressStep.textContent = "Invite";
      }

      const ownerAck = document.querySelector('[data-ack="accountOwnerResponsibility"]')?.closest("label")?.querySelector("span");
      if (ownerAck) {
        ownerAck.textContent = "As an account user, I must follow contract terms and updates shared by the account owner or RORC.";
      }

      byId("guestEntryChoice")?.remove();
      byId("heaterAccessChoice")?.remove();
      syncConditionalContractApplicability();
      syncHeaterDependentAcknowledgements();

      setResult("");
      return true;
    } catch (error) {
      inviteLoadError = error.message || "Could not load account invite.";
      setResult(inviteLoadError, "error");
      byId("signupNext").disabled = true;
      byId("signupSubmit").disabled = true;
      return false;
    }
  }

  function stringValue(value) {
    return String(value || "").trim();
  }

  function isUnder13(dateOfBirth) {
    const birth = new Date(`${dateOfBirth}T00:00:00Z`);
    if (Number.isNaN(birth.getTime())) return false;
    const today = new Date();
    const thirteenthBirthday = new Date(Date.UTC(birth.getUTCFullYear() + 13, birth.getUTCMonth(), birth.getUTCDate()));
    return today.getTime() < thirteenthBirthday.getTime();
  }

  function isAtLeast18(dateOfBirth) {
    const birth = new Date(`${dateOfBirth}T00:00:00Z`);
    if (Number.isNaN(birth.getTime())) return false;
    const today = new Date();
    const eighteenthBirthday = new Date(Date.UTC(birth.getUTCFullYear() + 18, birth.getUTCMonth(), birth.getUTCDate()));
    return today.getTime() >= eighteenthBirthday.getTime();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  document.querySelectorAll("[data-plan]").forEach((button) => {
    button.addEventListener("click", () => selectPlan(button.dataset.plan));
  });

  document.querySelectorAll("[data-progress-step]").forEach((item) => {
    function openProgressStep() {
      const targetStep = Number(item.dataset.progressStep);
      if (targetStep > maxStepReached || targetStep === step) return;
      if (targetStep > step && !validateCurrentStep()) return;
      setStep(targetStep);
    }

    item.addEventListener("click", openProgressStep);
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openProgressStep();
    });
  });

  byId("addHouseholdMember")?.addEventListener("click", addHouseholdMember);
  byId("householdMembers")?.addEventListener("input", syncConditionalContractApplicability);
  byId("householdMembers")?.addEventListener("change", syncConditionalContractApplicability);
  byId("signupBack")?.addEventListener("click", () => setStep(step - 1));
  byId("signupNext")?.addEventListener("click", () => {
    if (!validateCurrentStep()) return;
    maxStepReached = Math.max(maxStepReached, step + 1);
    setStep(step + 1);
  });
  document.querySelectorAll('input[name="allowHeaterUse"]').forEach((input) => {
    input.addEventListener("change", syncHeaterDependentAcknowledgements);
  });
  form.addEventListener("submit", submitSignup);
  byId("contractScrollBox")?.addEventListener("scroll", syncContractReadState, { passive: true });
  document.querySelectorAll(".signup-contract-photos img").forEach((image) => {
    image.addEventListener("load", syncContractReadState, { once: true });
  });

  async function init() {
    const today = new Date().toISOString().slice(0, 10);
    byId("signatureDate").value = today;
    if (!inviteToken) {
      selectPlan(String(urlParams.get("plan") || "full_facility"));
    }
    syncConditionalContractApplicability();
    syncHeaterDependentAcknowledgements();
    const inviteReady = await loadInvitation();
    setStep(0);
    if (inviteReady === false) {
      setResult(inviteLoadError, "error");
      byId("signupNext").disabled = true;
      byId("signupSubmit").disabled = true;
    }
  }

  init();
})();
