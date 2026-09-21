// @ts-nocheck
import { validateLispSymbol } from "./scanner.js";

const LANGUAGES = new Set(["generic", "elisp", "clojure", "common_lisp"]);
const POLICIES = new Set(["exact", "preserve_qualification", "leaf_only"]);

function languageName(value) {
  const normalized = value === "common-lisp" ? "common_lisp" : (value ?? "generic");
  if (!LANGUAGES.has(normalized)) throw new TypeError(`unsupported Lisp language: ${String(value)}`);
  return normalized;
}

function base(raw, language, values = {}) {
  return {
    raw,
    language,
    kind: "plain_symbol",
    qualifier: null,
    separator: null,
    name: raw,
    keyword: false,
    renameable: true,
    reason: null,
    normalized_identity: language === "common_lisp" ? raw.toUpperCase() : raw,
    ...values
  };
}

function splitOnce(raw, separator) {
  const index = raw.indexOf(separator);
  if (index < 0) return null;
  return [raw.slice(0, index), raw.slice(index + separator.length)];
}

export function describeLispSymbol(raw, language = "generic") {
  validateLispSymbol(raw);
  const lang = languageName(language);
  if (raw.includes("|") || raw.includes("\\")) {
    return base(raw, lang, { kind: "escaped_or_reader_sensitive", renameable: false, reason: "escaped_symbol_requires_reader_aware_backend" });
  }
  if (lang === "generic" || lang === "elisp") {
    if (raw.startsWith(":")) return base(raw, lang, { kind: "keyword", name: raw.slice(1), keyword: true, renameable: false, reason: "keyword_rename_requires_explicit_data_migration" });
    return base(raw, lang);
  }
  if (lang === "clojure") {
    if (raw.startsWith("::")) {
      const body = raw.slice(2);
      const parts = splitOnce(body, "/");
      return base(raw, lang, {
        kind: parts ? "auto_resolved_qualified_keyword" : "auto_resolved_keyword",
        qualifier: parts?.[0] ?? null,
        separator: parts ? "/" : null,
        name: parts?.[1] ?? body,
        keyword: true,
        renameable: false,
        reason: "auto_resolved_keyword_depends_on_namespace_context"
      });
    }
    if (raw.startsWith(":")) {
      const body = raw.slice(1);
      const parts = splitOnce(body, "/");
      return base(raw, lang, {
        kind: parts ? "qualified_keyword" : "keyword",
        qualifier: parts?.[0] ?? null,
        separator: parts ? "/" : null,
        name: parts?.[1] ?? body,
        keyword: true,
        renameable: false,
        reason: "keyword_rename_requires_explicit_data_migration"
      });
    }
    if (raw.startsWith("#")) return base(raw, lang, { kind: "reader_sensitive", renameable: false, reason: "reader_prefixed_symbol_requires_clojure_reader" });
    if (raw !== "/" && raw.includes("/")) {
      const first = raw.indexOf("/");
      if (first <= 0 || first !== raw.lastIndexOf("/") || first === raw.length - 1) {
        return base(raw, lang, { kind: "invalid_qualified_symbol", renameable: false, reason: "invalid_clojure_namespace_qualification" });
      }
      return base(raw, lang, { kind: "qualified_symbol", qualifier: raw.slice(0, first), separator: "/", name: raw.slice(first + 1) });
    }
    return base(raw, lang, { kind: raw.endsWith("#") ? "auto_gensym_symbol" : "plain_symbol", renameable: !raw.endsWith("#"), reason: raw.endsWith("#") ? "auto_gensym_is_reader_scoped" : null });
  }
  if (raw.startsWith("#:")) return base(raw, lang, { kind: "uninterned_symbol", name: raw.slice(2), renameable: false, reason: "uninterned_symbol_has_no_stable_project_identity" });
  if (raw.startsWith(":")) return base(raw, lang, { kind: "keyword", name: raw.slice(1), keyword: true, renameable: false, reason: "keyword_rename_requires_explicit_data_migration" });
  const internal = raw.indexOf("::");
  if (internal >= 0) {
    if (internal === 0 || internal !== raw.lastIndexOf("::") || internal + 2 >= raw.length || raw.slice(internal + 2).includes(":")) {
      return base(raw, lang, { kind: "invalid_package_symbol", renameable: false, reason: "invalid_common_lisp_package_qualification" });
    }
    const qualifier = raw.slice(0, internal);
    const name = raw.slice(internal + 2);
    return base(raw, lang, { kind: "package_internal_symbol", qualifier, separator: "::", name, normalized_identity: `${qualifier.toUpperCase()}::${name.toUpperCase()}` });
  }
  const external = raw.indexOf(":");
  if (external >= 0) {
    if (external === 0 || external !== raw.lastIndexOf(":") || external === raw.length - 1) {
      return base(raw, lang, { kind: "invalid_package_symbol", renameable: false, reason: "invalid_common_lisp_package_qualification" });
    }
    const qualifier = raw.slice(0, external);
    const name = raw.slice(external + 1);
    return base(raw, lang, { kind: "package_external_symbol", qualifier, separator: ":", name, normalized_identity: `${qualifier.toUpperCase()}:${name.toUpperCase()}` });
  }
  return base(raw, lang, { normalized_identity: raw.toUpperCase() });
}

function reconstruct(descriptor, leaf) {
  if (descriptor.separator && descriptor.qualifier) return `${descriptor.qualifier}${descriptor.separator}${leaf}`;
  return leaf;
}

export function prepareSymbolRename({ oldSymbol, newSymbol, language = "generic", qualificationPolicy } = {}) {
  const lang = languageName(language);
  const policy = qualificationPolicy ?? (lang === "generic" || lang === "elisp" ? "exact" : "preserve_qualification");
  if (!POLICIES.has(policy)) throw new TypeError(`unsupported qualification policy: ${String(policy)}`);
  const oldDescriptor = describeLispSymbol(oldSymbol, lang);
  const requestedNewDescriptor = describeLispSymbol(newSymbol, lang);
  if (!oldDescriptor.renameable) {
    const error = new Error(`old symbol is not safely renameable: ${oldDescriptor.reason}`);
    error.code = "E_SYMBOL_NOT_RENAMEABLE";
    error.details = oldDescriptor;
    throw error;
  }
  let effectiveNew = newSymbol;
  let newDescriptor = requestedNewDescriptor;
  if (policy === "leaf_only" && oldDescriptor.qualifier && requestedNewDescriptor.qualifier === null && requestedNewDescriptor.renameable) {
    effectiveNew = reconstruct(oldDescriptor, requestedNewDescriptor.name);
    newDescriptor = describeLispSymbol(effectiveNew, lang);
  }
  if (!newDescriptor.renameable) {
    const error = new Error(`new symbol is not safely renameable: ${newDescriptor.reason}`);
    error.code = "E_SYMBOL_NOT_RENAMEABLE";
    error.details = newDescriptor;
    throw error;
  }
  if (oldDescriptor.normalized_identity === newDescriptor.normalized_identity) {
    const error = new Error("old and new symbols have the same language-level identity");
    error.code = "E_SYMBOL_IDENTITY_UNCHANGED";
    error.details = { old: oldDescriptor, new: newDescriptor };
    throw error;
  }
  if (policy === "preserve_qualification" || policy === "leaf_only") {
    const oldQualifier = lang === "common_lisp" && typeof oldDescriptor.qualifier === "string" ? oldDescriptor.qualifier.toUpperCase() : oldDescriptor.qualifier;
    const newQualifier = lang === "common_lisp" && typeof newDescriptor.qualifier === "string" ? newDescriptor.qualifier.toUpperCase() : newDescriptor.qualifier;
    if (oldDescriptor.kind !== newDescriptor.kind || oldQualifier !== newQualifier || oldDescriptor.separator !== newDescriptor.separator) {
      const error = new Error("rename would change namespace/package qualification semantics");
      error.code = "E_SYMBOL_QUALIFICATION_CHANGE";
      error.details = { old: oldDescriptor, requested_new: requestedNewDescriptor, effective_new: newDescriptor, policy };
      throw error;
    }
  }
  return {
    language: lang,
    qualification_policy: policy,
    old: oldDescriptor,
    requested_new: requestedNewDescriptor,
    new: newDescriptor,
    effective_new_symbol: effectiveNew
  };
}
