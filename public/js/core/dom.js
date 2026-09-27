export const $ = selector => document.querySelector(selector);
export const $$ = selector => document.querySelectorAll(selector);
export function escapeHtml(value) {
  const node = document.createElement("div");
  node.textContent = value ?? "";
  return node.innerHTML;
}
