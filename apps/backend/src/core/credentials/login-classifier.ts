// Ported from Hermes Agent agent/vault_login_classifier.py (MIT, Copyright (c) 2025 Nous Research) and Merit-Systems/OpenInstinct kernel-login-autofill.ts (MIT).

export type LoginToken = "username" | "email" | "tel" | "current-password";

export interface PageControl {
    autocomplete: string;
    formIndex: number | null;
    index: number;
    label: string;
    name: string;
    type: string;
    maxLength: number | null;
}

export interface ClassifiedControl {
    control: PageControl;
    score: number;
    token: LoginToken | "one-time-code";
}

export interface ControlFill {
    index: number;
    token: ClassifiedControl["token"];
    value: string;
}

const LOGIN_TOKENS: LoginToken[] = ["username", "email", "tel", "current-password"];
const EXCLUDED_AUTOCOMPLETE = new Set(["new-password", "one-time-code"]);
const EXCLUDED_PASSWORD = /\b(?:new|confirm|create|repeat|nova|confirmar|confirme|repita)\s*(?:password|senha)\b/;
const EMAIL = /\b(?:e\s?mail|email address)\b/;
const TEL = /\b(?:phone|telephone|mobile|celular|telefone)\b/;
const USERNAME = /\b(?:user\s*name|username|login|account|member|usuario|cpf)\b/;
const OTP = /\b(?:one\s?time|verification|verificacao|security|seguranca|auth(?:entication|enticator)?|2fa|two\s?factor|mfa|totp|otp|passcode|sms)\b.*\b(?:code|codigo|pin|token)\b|\b(?:otp|totp|2fa|mfa|verification\s*code|codigo\s*de\s*verificacao|passcode)\b/;

function normalize(value: string): string {
    return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function searchable(control: PageControl): string {
    return normalize([control.name, control.label].filter(Boolean).join(" "));
}

export function classifyLoginControl(control: PageControl): ClassifiedControl | null {
    const tokens = control.autocomplete.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.some((token) => EXCLUDED_AUTOCOMPLETE.has(token))) return null;
    const exact = LOGIN_TOKENS.find((token) => tokens.includes(token));
    if (exact) return { control, score: 100, token: exact };
    const text = searchable(control);
    if (EXCLUDED_PASSWORD.test(text)) return null;
    if (control.type === "password") return { control, score: 90, token: "current-password" };
    if (control.type === "email") return { control, score: 85, token: "email" };
    if (control.type === "tel") return { control, score: 85, token: "tel" };
    if (EMAIL.test(text)) return { control, score: 75, token: "email" };
    if (TEL.test(text)) return { control, score: 75, token: "tel" };
    if (USERNAME.test(text)) return { control, score: 70, token: "username" };
    return null;
}

const CODE_TYPES = ["text", "tel", "number", "password", ""];

export function classifyOtpControls(controls: PageControl[]): ClassifiedControl[] {
    const matched = controls.flatMap((control): ClassifiedControl[] => {
        if (control.autocomplete.toLowerCase().split(/\s+/).includes("one-time-code")) {
            return [{ control, score: 100, token: "one-time-code" }];
        }
        if (!CODE_TYPES.includes(control.type)) return [];
        return OTP.test(searchable(control)) ? [{ control, score: 70, token: "one-time-code" }] : [];
    });
    if (matched.length > 0) return matched;
    const boxes = controls.filter((control) => control.maxLength === 1 && CODE_TYPES.includes(control.type)).sort((a, b) => a.index - b.index);
    let run: PageControl[] = [];
    for (const box of boxes) {
        const previous = run[run.length - 1];
        run = previous && box.index - previous.index === 1 && box.formIndex === previous.formIndex ? [...run, box] : [box];
        const next = boxes[boxes.indexOf(box) + 1];
        const ends = !next || next.index - box.index !== 1 || next.formIndex !== box.formIndex;
        if (ends && run.length >= 4 && run.length <= 8) return run.map((control) => ({ control, score: 60, token: "one-time-code" }));
    }
    return [];
}

const best = (controls: ClassifiedControl[]) =>
    [...controls].sort((a, b) => b.score - a.score || a.control.index - b.control.index)[0];

export function selectLoginFills(controls: PageControl[], values: { identifier?: string; password?: string }): ControlFill[] {
    const classified = controls.map(classifyLoginControl).filter((item): item is ClassifiedControl => item !== null);
    const fills: ControlFill[] = [];
    const password = best(classified.filter((item) => item.token === "current-password"));
    if (password && values.password) fills.push({ index: password.control.index, token: password.token, value: values.password });
    const identifiers = classified.filter((item) => item.token !== "current-password");
    const sameForm = password ? identifiers.filter((item) => item.control.formIndex === password.control.formIndex) : [];
    const identifier = best(sameForm.length > 0 ? sameForm : identifiers);
    if (identifier && values.identifier) fills.push({ index: identifier.control.index, token: identifier.token, value: values.identifier });
    return fills;
}

export function selectOtpFills(otpControls: ClassifiedControl[], code: string): ControlFill[] {
    const boxes = otpControls.filter((item) => item.control.maxLength === 1).sort((a, b) => a.control.index - b.control.index);
    const perDigit = boxes.length === code.length
        && new Set(boxes.map((box) => box.control.formIndex)).size === 1
        && boxes.every((box, i) => i === 0 || box.control.index - boxes[i - 1].control.index === 1);
    if (perDigit) return boxes.map((box, i) => ({ index: box.control.index, token: "one-time-code", value: code[i] }));
    const top = best(otpControls);
    return top ? [{ index: top.control.index, token: "one-time-code", value: code }] : [];
}

const STAMP = "data-specbook-vault-slot";

export function inspectionFunction(nonce: string): string {
    return `() => {
  const nonce = ${JSON.stringify(nonce)};
  const elements = Array.from(document.querySelectorAll("input, select"));
  const forms = Array.from(document.forms);
  elements.forEach((element, index) => element.setAttribute(${JSON.stringify(STAMP)}, nonce + ":" + index));
  return elements.flatMap((element, index) => {
    if (element.disabled || element.readOnly) return [];
    if (["hidden", "submit", "button", "reset", "file", "image", "checkbox", "radio"].includes(element.type)) return [];
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) return [];
    const labels = element.labels ? Array.from(element.labels, (label) => label.textContent || "") : [];
    const aria = (element.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "").join(" ");
    const formIndex = element.form ? forms.indexOf(element.form) : -1;
    return [{
      autocomplete: element.autocomplete || "",
      formIndex: formIndex >= 0 ? formIndex : null,
      index,
      maxLength: element.maxLength > 0 ? element.maxLength : null,
      label: [...labels, element.getAttribute("aria-label") || "", aria, element.getAttribute("placeholder") || "", element.getAttribute("title") || ""].join(" "),
      name: [element.name, element.id].join(" "),
      type: element.tagName === "SELECT" ? "select" : (element.type || ""),
    }];
  });
}`;
}

export function fillFunction(fills: ControlFill[], expectedOrigin: string, nonce: string): string {
    return `() => {
  if (window.location.origin !== ${JSON.stringify(expectedOrigin)}) return { refused: "origin_changed", found: window.location.origin };
  const fills = ${JSON.stringify(fills)};
  const nonce = ${JSON.stringify(nonce)};
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  let filled = 0;
  for (const fill of fills) {
    const element = document.querySelector('[${STAMP}="' + nonce + ':' + fill.index + '"]');
    if (!element || (fill.token === "current-password" && element.type !== "password")) continue;
    try {
      element.focus();
      if (setter) setter.call(element, fill.value); else element.value = fill.value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      if (element.value.length > 0) filled += 1;
    } catch {}
  }
  document.querySelectorAll("[${STAMP}]").forEach((node) => node.removeAttribute(${JSON.stringify(STAMP)}));
  return { filled };
}`;
}

export function parsePageControls(value: unknown): PageControl[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const item = raw as Record<string, unknown>;
        return [{
            autocomplete: String(item.autocomplete ?? ""),
            formIndex: typeof item.formIndex === "number" ? item.formIndex : null,
            index: Number(item.index ?? 0),
            label: String(item.label ?? ""),
            name: String(item.name ?? ""),
            type: String(item.type ?? ""),
            maxLength: typeof item.maxLength === "number" ? item.maxLength : null,
        }];
    });
}
