function billingAddress(value, required = false) {
 const address = {};
 for (const key of ['line1','line2','city','state','postal_code','country']) {
  const raw = value?.[key] ?? '';
  if (typeof raw !== 'string' || raw.length > 250) throw Object.assign(new Error('Enter a valid billing address.'), {status:400,statusCode:400});
  address[key] = raw.trim();
 }
 address.country = address.country.toUpperCase();
 if (required && ['line1','city','state','postal_code','country'].some(key => !address[key])) throw Object.assign(new Error('Billing street address, city, state, ZIP and country are required.'), {status:400,statusCode:400});
 if (address.country && !/^[A-Z]{2}$/.test(address.country)) throw Object.assign(new Error('Use a two-letter billing country code, such as US.'), {status:400,statusCode:400});
 return address;
}
module.exports = { billingAddress };
