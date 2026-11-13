import { h, api, pageHead, toast, errMsg, can, confirmDialog, copyBtn, fmtBytes, ago, icon, input, dialog, field } from "../ui.js";

export default async function media({ go }) {
  const { data } = await api("GET", "/media", { query: { limit: 200 } });
  const fileIn = h("input", { type: "file", multiple: true, accept: "image/*,video/mp4,video/webm,audio/*,application/pdf", hidden: true });
  const upload = async (files) => {
    for (const f of files) {
      try { const r = await api("POST", "/media", { raw: f, headers: { "Content-Type": f.type || "application/octet-stream" }, query: { filename: f.name } }); toast(r.meta?.duplicate ? `${f.name} was already in the library` : `Uploaded ${f.name}`, "ok"); }
      catch (e) { toast(`${f.name}: ${errMsg(e)}`, "bad"); }
    }
    go("/admin/media", { replace: true });
  };
  fileIn.addEventListener("change", () => upload([...fileIn.files]));
  const drop = h("div", { class: "drop" }, icon("upload"), h("p", null, "Drag files here or ", h("button", { class: "btn btn--sm", type: "button", onclick: () => fileIn.click() }, "choose files")), h("p", { class: "tiny" }, "Images (WebP/AVIF recommended), video, audio, PDF · max 25 MB · stored in R2, served from /media/…"), fileIn);
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => upload([...e.dataTransfer.files]));
  const item = (m) => h("div", { class: "media-item" },
    h("div", { class: "media-item__img" }, m.content_type.startsWith("image/") ? h("img", { src: m.url, alt: m.alt || "", loading: "lazy" }) : m.content_type.split("/")[1].toUpperCase()),
    h("div", { class: "media-item__body" }, h("span", { class: "name", title: m.filename }, m.filename), h("span", { class: "muted" }, `${fmtBytes(m.size)} · ${ago(m.created_at)}`),
      h("div", { class: "row" }, copyBtn(m.url, "URL"),
        can("media:update") ? h("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: () => altDialog(m, go) }, "Alt") : null,
        can("media:delete") ? h("button", { class: "btn btn--sm btn--ghost", type: "button", "aria-label": `Delete ${m.filename}`, onclick: async () => {
          if (!(await confirmDialog({ title: `Delete ${m.filename}?`, body: "Pages that use it will show a broken image.", danger: true, ok: "Delete" }))) return;
          try { const r = await api("DELETE", `/media/${m.id}`); toast(r.data.was_referenced_by.length ? `Deleted — it was used by ${r.data.was_referenced_by.map((x) => x.id).join(", ")}` : "Deleted", "ok"); go("/admin/media", { replace: true }); } catch (e) { toast(errMsg(e), "bad"); }
        } }, icon("trash")) : null)));
  return h("div", { class: "stack" }, pageHead("Media library", `${data.length} file(s). Copy a URL and paste it into a game, post or team member.`), can("media:create") ? drop : null,
    data.length ? h("div", { class: "media-grid" }, data.map(item)) : h("div", { class: "card empty" }, h("img", { src: "/assets/mark.svg", alt: "" }), "No files yet."));
}
function altDialog(m, go) {
  dialog((close) => { const a = input("alt", m.alt, { maxlength: 300 }); return h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault(); try { await api("PATCH", `/media/${m.id}`, { body: { alt: a.value } }); close(); go("/admin/media", { replace: true }); } catch (x) { toast(errMsg(x), "bad"); } } }, h("h2", null, "Alt text"), field("Describe the image", a), h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--primary" }, "Save"))); });
}
