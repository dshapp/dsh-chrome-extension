// Main-area page ownership. Conversation state keeps updating behind management pages.
import { t } from "../../shared/i18n.js";
import { lucideIconSvg } from "../../features/chat/file-icons.js";

export function mountMainSurfaces(root, { pages = {}, beforeOpen, onClose, onError } = {}) {
  const host = root.querySelector("#management-surface");
  const content = host.querySelector("#management-content");
  const heading = host.querySelector("#management-title");
  const back = host.querySelector("#management-back");
  const document = host.ownerDocument;
  const instances = new Map();
  const sections = new Map();
  const pending = new Map();
  let active = null;
  let epoch = 0;
  let suspended = false;
  let disposed = false;

  function relabel() {
    heading.textContent = active ? t(pages[active].titleKey) : "";
    back.innerHTML = lucideIconSvg("chevron-left", { size: 15 });
    back.setAttribute("aria-label", t("management.back"));
    back.title = t("management.back");
    for (const button of root.querySelectorAll("[data-main-surface]")) {
      const name = button.dataset.mainSurface;
      const selected = name === active;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
      const label = button.querySelector("[data-navigation-label]");
      if (label && pages[name]) label.textContent = t(pages[name].titleKey);
    }
    for (const page of instances.values()) page.relabel?.();
  }

  async function obtain(name) {
    if (instances.has(name)) return instances.get(name);
    if (!pending.has(name)) {
      const section = document.createElement("section");
      section.className = "management-page";
      section.dataset.page = name;
      section.hidden = true;
      sections.set(name, section);
      content.append(section);
      const task = Promise.resolve().then(() => pages[name].mount(section)).then((page) => {
        if (disposed) { page?.dispose?.(); section.remove(); return null; }
        page?.setVisible?.(false, { refresh: false });
        instances.set(name, page ?? {});
        return page ?? {};
      }).catch((error) => {
        section.remove(); sections.delete(name); throw error;
      }).finally(() => pending.delete(name));
      pending.set(name, task);
    }
    return pending.get(name);
  }

  async function open(name) {
    if (disposed || !pages[name]) return false;
    const token = ++epoch;
    // Closing a Settings overlay may resume the old page; hide it afterwards.
    beforeOpen?.(name);
    if (active !== name) instances.get(active)?.setVisible?.(false);
    active = name;
    suspended = false;
    host.hidden = false;
    document.body.classList.add("management-open");
    for (const [key, section] of sections) section.hidden = key !== name;
    relabel();
    try {
      const page = await obtain(name);
      if (disposed || token !== epoch || active !== name) return false;
      sections.get(name).hidden = false;
      if (typeof page.setVisible === "function") await page.setVisible(!suspended);
      else if (!suspended) await page.refresh?.();
      return token === epoch;
    } catch (error) {
      if (token === epoch && !disposed) onError?.(error);
      return false;
    }
  }

  function close({ restoreFocus = false } = {}) {
    ++epoch;
    instances.get(active)?.setVisible?.(false);
    active = null;
    suspended = false;
    host.hidden = true;
    document.body.classList.remove("management-open");
    relabel();
    onClose?.({ restoreFocus });
  }

  function setSuspended(value) {
    if (suspended === Boolean(value)) return;
    suspended = Boolean(value);
    const page = instances.get(active);
    if (page) Promise.resolve(page.setVisible?.(!suspended)).catch((error) => onError?.(error));
  }

  const click = (event) => {
    const button = event.target.closest?.("[data-main-surface]");
    if (button) void open(button.dataset.mainSurface);
  };
  const backClick = () => close({ restoreFocus: true });
  root.addEventListener("click", click);
  back.addEventListener("click", backClick);
  relabel();
  return {
    open, close, relabel, setSuspended,
    isOpen: () => active !== null,
    active: () => active,
    dispose() {
      close(); disposed = true;
      root.removeEventListener("click", click);
      back.removeEventListener("click", backClick);
      for (const page of instances.values()) page.dispose?.();
      for (const section of sections.values()) section.remove();
      instances.clear(); sections.clear();
    }
  };
}
