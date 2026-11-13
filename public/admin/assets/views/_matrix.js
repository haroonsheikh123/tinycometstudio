/* Resource × action permission matrix. Boxes you don't hold yourself are disabled (you can't grant more than you have). */
import { h, api, state } from "../ui.js";
let catalog = null;
export async function getCatalog() { return (catalog ||= (await api("GET", "/permissions")).data); }
export async function matrix(selected = [], { readOnly = false } = {}) {
  const cat = await getCatalog();
  const mine = state.me.permissions;
  const has = (p) => mine.includes("*") || mine.includes(p);
  const sel = new Set(selected.includes("*") ? Object.entries(cat.resources).flatMap(([r, d]) => d.actions.map((a) => `${r}:${a}`)) : selected);
  const el = h("div", { class: "table-wrap" }, h("table", { class: "matrix" },
    h("thead", null, h("tr", null, h("th", { scope: "col" }, "Resource"), cat.actions.map((a) => h("th", { scope: "col" }, a)), h("th", { scope: "col" }, "All"))),
    h("tbody", null, Object.entries(cat.resources).map(([r, d]) => {
      const boxes = [];
      const row = h("tr", null, h("td", null, d.label, d.hint ? h("small", null, d.hint) : null), cat.actions.map((a) => {
        if (!d.actions.includes(a)) return h("td", { class: "na" }, "·");
        const p = `${r}:${a}`;
        const owner = cat.owner_only.includes(p);
        const b = h("input", { type: "checkbox", value: p, checked: sel.has(p) && !owner, disabled: readOnly || !has(p) || owner, "aria-label": `${d.label}: ${a}`, title: owner ? "Owner only" : !has(p) ? "You don't have this permission, so you can't grant it" : p });
        boxes.push(b);
        return h("td", null, b);
      }), h("td", null, readOnly ? null : h("input", { type: "checkbox", "aria-label": `All ${d.label}`, checked: boxes.length > 0 && boxes.every((b) => b.checked), onchange: (e) => boxes.forEach((b) => { if (!b.disabled) b.checked = e.target.checked; }) })));
      return row;
    }))));
  el.value = () => [...el.querySelectorAll("input[value]:checked")].map((i) => i.value);
  return el;
}
