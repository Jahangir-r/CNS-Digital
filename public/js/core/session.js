const TOKEN_KEY = "cns_auth_token";
export const sessionToken = {
  read: () => localStorage.getItem(TOKEN_KEY) || "",
  save: value => value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};
