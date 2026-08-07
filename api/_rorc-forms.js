const FORM_DEFINITIONS = {
  membership: {
    id: "membership",
    title: "membership signup",
    url: "https://www.ruthobenchainrc.com/membership-signup/",
    fields: [
      { key: "planId", type: "choice", prompt: "Which membership would you like: Open Gym, Weight Room Only, Full Facility, or Full Facility plus Wi-Fi?", options: { open_gym: ["open gym"], weight_room: ["weight room", "weight room only"], full_facility_wifi: ["full facility plus wifi", "full facility with wifi", "wifi"], full_facility: ["full facility"] } },
      { key: "primaryName", type: "text", prompt: "What is the primary member's full name?" },
      { key: "primaryEmail", type: "email", prompt: "What email address should go on the membership?" },
      { key: "primaryPhone", type: "phone", prompt: "Should I use the phone number you are calling from? Say yes, or tell me a different number.", callerPhoneAllowed: true },
      { key: "primaryAddress", type: "text", prompt: "What mailing address should I prefill? You can also say skip." },
    ],
  },
  rental: {
    id: "rental",
    title: "facility rental application",
    url: "https://www.ruthobenchainrc.com/rentals/",
    fields: [
      { key: "contactName", type: "text", prompt: "What is the primary contact's full name?" },
      { key: "contactPhone", type: "phone", prompt: "Should I use the phone number you are calling from? Say yes, or tell me a different number.", callerPhoneAllowed: true },
      { key: "contactEmail", type: "email", prompt: "What email address should go on the rental application?" },
      { key: "contactAddress", type: "text", prompt: "What mailing address should go on it? You can say skip." },
      { key: "eventName", type: "text", prompt: "What should the event be called?" },
      { key: "eventType", type: "choice", prompt: "What kind of event is it: birthday party, private party, meeting, memorial service, or something else?", options: { "Birthday Party": ["birthday", "birthday party"], "Private Party": ["private party", "party"], Meeting: ["meeting"], "Memorial Service": ["memorial", "memorial service", "funeral"], Other: ["other", "something else"] } },
      { key: "eventDate", type: "date", prompt: "What date would you like for the event?" },
      { key: "eventStartTime", type: "time", prompt: "What time would you need access to begin?" },
      { key: "eventEndTime", type: "time", prompt: "What time would access end?" },
      { key: "estimatedAttendance", type: "number", prompt: "About how many people do you expect?" },
      { key: "isPrivateEvent", type: "yesno", prompt: "Will this be a private event?" },
      { key: "foodOrDrinks", type: "yesno", prompt: "Will food or drinks be served?" },
      { key: "alcohol", type: "yesno-title", prompt: "Will alcohol be present?" },
    ],
  },
  sponsor: {
    id: "sponsor",
    title: "banner sponsorship form",
    url: "https://www.ruthobenchainrc.com/sponsors/form/",
    fields: [
      { key: "businessName", type: "text", prompt: "What business or organization name should appear on the sponsorship?" },
      { key: "contactName", type: "text", prompt: "What is the contact person's full name?" },
      { key: "emailAddress", type: "email", prompt: "What is the contact email address?" },
      { key: "phoneNumber", type: "phone", prompt: "Should I use the phone number you are calling from? Say yes, or tell me a different number.", callerPhoneAllowed: true },
      { key: "sponsorshipType", type: "choice", prompt: "Is this a new sponsorship or a renewal?", options: { new: ["new", "new sponsorship"], renewal: ["renew", "renewal"] } },
      { key: "bannerText", type: "text", prompt: "What wording would you like on the banner? You can say skip and enter it online." },
      { key: "designRequests", type: "text", prompt: "Do you have any design requests? You can say skip." },
      { key: "paymentMethod", type: "choice", prompt: "Would you prefer to mail a check or receive a Stripe invoice?", options: { mail_check: ["mail", "mail a check", "check"], stripe_invoice: ["stripe", "invoice", "stripe invoice", "online"] } },
    ],
  },
};

function getFormDefinition(formId) {
  return FORM_DEFINITIONS[String(formId || "").toLowerCase()] || null;
}

function detectFormRequest(value) {
  const text = String(value || "").toLowerCase();
  if (/\bi (?:want|would like|need) to (?:become a |renew my )?(?:sponsor|sponsorship)\b/.test(text)) return "sponsor";
  if (/\bi(?:'d| would) like to rent\b|\bi (?:want|would like|need) to rent\b|\bbook (?:the |a )?(?:gym|facility|center)\b/.test(text)) return "rental";
  if (/\b(sponsor|sponsorship|banner)\b.{0,80}\b(form|apply|application|sign ?up|fill|submit|renew)\b|\b(form|apply|application|sign ?up|fill|submit|renew)\b.{0,80}\b(sponsor|sponsorship|banner)\b/.test(text)) return "sponsor";
  if (!/\b(price|pricing|cost|how much)\b/.test(text) && /\b(help|guide|walk|step by step)\b.{0,100}\b(rent|rental|book|reserve|facility application|rental application|rental form)\b|\b(rent|rental|book|reserve|facility application|rental application|rental form)\b.{0,100}\b(help|guide|walk|step by step)\b/.test(text)) return "rental";
  if (/\b(rent|rental|reservation|book|booking|event)\b.{0,80}\b(form|apply|application|request|reserve|book|fill|submit)\b|\b(form|apply|application|request|reserve|book|fill|submit)\b.{0,80}\b(rent|rental|facility|event)\b/.test(text)) return "rental";
  if (/\b(member|membership|join|enroll)\b.{0,80}\b(form|apply|application|sign ?up|join|enroll|fill|submit)\b|\b(form|apply|application|sign ?up|join|enroll|fill|submit)\b.{0,80}\b(member|membership|rorc)\b|^i (?:want|would like) to join\b/.test(text)) return "membership";
  return "";
}

module.exports = { FORM_DEFINITIONS, getFormDefinition, detectFormRequest };
