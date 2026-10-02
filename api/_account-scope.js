// Resolve a selected member against explicit grants, never email/phone matches.
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
async function accountMemberFilter(authUserId, req, rest) {
  const selected = req?.headers?.['x-rorc-account-member'];
  if (!selected) return `auth_user_id=eq.${encodeURIComponent(authUserId)}`;
  const deny = () => Object.assign(new Error('You do not have access to the selected account.'), {status:403,statusCode:403});
  if (typeof selected !== 'string' || !uuid(selected)) throw deny();
  const own = await rest(`account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&id=eq.${selected}&limit=1`);
  if (own?.length) return `id=eq.${selected}`;
  const grants = await rest(`member_account_access?select=account_member_id&auth_user_id=eq.${encodeURIComponent(authUserId)}&account_member_id=eq.${selected}&limit=1`);
  if (!grants?.length) throw deny();
  const target = await rest(`account_members?select=id,account_type&id=eq.${selected}&limit=1`);
  if (!target?.length || target[0].account_type === 'Account Manager') throw deny();
  return `id=eq.${selected}`;
}
module.exports = {accountMemberFilter};
