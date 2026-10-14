// Conservative fallback: custom credential / model / compound pages remain distinct.
import { t } from "../../../shared/i18n.js";
import { section, stackedRow, textInput, select, button, escapeHtml, notice } from "./settings-ui.js";
const at = (root, path) => path.reduce((value, key) => value?.[key], root);
const localized = value => typeof value === "string" ? value : value?.en ?? "";
export function schemaFields(schema, path = []) {
  if (!schema || schema.meta?.role === "secret" || schema.meta?.hidden) return [];
  if (schema.type === "object") return Object.entries(schema.dict ?? schema.properties ?? {}).flatMap(([key, child]) => schemaFields(child, [...path, key]));
  if (!path.length) return [];
  return [{ path, schema, editable: ["string", "number", "integer", "boolean"].includes(schema.type) }];
}
export function parseSchemaValue(field, text) {
  const { schema } = field;
  if (text === "") return { op: "unset", path: field.path };
  let value = text;
  if (schema.type === "boolean") {
    if (!["true", "false"].includes(text)) throw new Error(t("plug.schemaInvalid"));
    value = text === "true";
  } else if (["number", "integer"].includes(schema.type)) {
    value = Number(text);
    const min = schema.minimum ?? schema.meta?.min;
    const max = schema.maximum ?? schema.meta?.max;
    if (!text.trim() || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))
      || (min !== undefined && value < min) || (max !== undefined && value > max)) throw new Error(t("plug.schemaInvalid"));
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(t("plug.schemaInvalid"));
  return { op: "set", path: field.path, value };
}
export function createPluginSchemaConfig({ settingsService, describeNow, onChange }) {
  const drafts = new Map(), errors = new Map(), saving = new Set();
  const namespaceOf = ns => describeNow()?.namespaces?.find(entry => entry.ns === ns);
  const draftFor = ns => { if (!drafts.has(ns)) drafts.set(ns, new Map()); return drafts.get(ns); };
  function render(ns) {
    const namespace = namespaceOf(ns);
    if (!namespace) return notice(t("plug.noConfiguration"), "muted");
    const writable = describeNow()?.writable === true && !saving.has(ns);
    const rows = schemaFields(namespace.schema).map((field, index) => {
      const stored = at(namespace.value, field.path);
      const text = draftFor(ns).get(JSON.stringify(field.path)) ?? (stored == null ? "" : String(stored));
      const id = "plug-schema-" + index;
      let control;
      if (!field.editable) control = '<pre class="set-code">' + escapeHtml(JSON.stringify(stored, null, 2) ?? "") + '</pre>';
      else if (field.schema.type === "boolean" || field.schema.enum) {
        const values = field.schema.enum ?? [true, false];
        control = select({ id, disabled: !writable, options: [{ value: "", label: t("plug.reset"), selected: text === "" }, ...values.map(value => ({ value: String(value), label: String(value), selected: text === String(value) }))] });
      } else control = textInput({ id, value: text, disabled: !writable });
      return stackedRow({ label: escapeHtml(localized(field.schema.meta?.description ?? field.schema.title) || field.path.join(".")), hint: escapeHtml(field.path.join(".")), control });
    }).join("");
    return section({ header: ns, body: rows + (errors.has(ns) ? notice(errors.get(ns)) : "")
      + button({ id: "plug-schema-discard", label: t("set.cancel"), disabled: saving.has(ns) })
      + button({ id: "plug-schema-save", label: t("set.save"), kind: "primary", disabled: !writable || !draftFor(ns).size }),
      footer: escapeHtml(t("plug.schemaLimitations")) });
  }
  function bind(host, ns) {
    const namespace = namespaceOf(ns);
    if (!namespace) return;
    const fields = schemaFields(namespace.schema);
    fields.forEach((field, index) => {
      host.querySelector("#plug-schema-" + index)?.addEventListener("change", event => {
        draftFor(ns).set(JSON.stringify(field.path), event.target.value);
        const save = host.querySelector("#plug-schema-save");
        if (save) save.disabled = describeNow()?.writable !== true;
      });
    });
    host.querySelector("#plug-schema-discard")?.addEventListener("click", () => { drafts.delete(ns); errors.delete(ns); onChange(); });
    host.querySelector("#plug-schema-save")?.addEventListener("click", async () => {
      if (saving.has(ns) || describeNow()?.writable !== true) return;
      try {
        const ops = fields.filter(field => field.editable && draftFor(ns).has(JSON.stringify(field.path)))
          .map(field => parseSchemaValue(field, draftFor(ns).get(JSON.stringify(field.path))));
        if (!ops.length) return;
        saving.add(ns); errors.delete(ns); onChange();
        await settingsService.mutate(ns, ops, namespace.revision);
        drafts.delete(ns);
        await describeNow({ refresh: true });
      } catch (error) { errors.set(ns, error?.message ?? String(error)); }
      finally { saving.delete(ns); onChange(); }
    });
  }
  return { render, bind, has: ns => Boolean(namespaceOf(ns)),
    form(ns) { const namespace = namespaceOf(ns); return namespace ? { state: { namespace, writable: describeNow()?.writable === true }, mutate: (ops, revision) => settingsService.mutate(ns, ops, revision ?? namespace.revision) } : undefined; },
    dispose() { drafts.clear(); errors.clear(); } };
}
