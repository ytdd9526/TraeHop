export const api = window.traeAccounts;

export async function unwrap(promise) {
  const res = await promise;
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
