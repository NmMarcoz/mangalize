import { invoke } from "@tauri-apps/api/core";

import type { Translator } from "@/lib/i18n/types";

/** Mirrors `settings::DeliveryConfig`. Never carries the password. */
export interface DeliveryConfig {
  kindle_email: string;
  from: string;
  host: string;
  port: number;
  /** `start-tls` | `tls` | `none` */
  security: string;
  username: string;
}

export interface DeliveryStatus {
  config: DeliveryConfig;
  /** Whether a password is in the OS keychain. The value itself never leaves it. */
  has_password: boolean;
}

export interface SendReport {
  sent: string[];
  failed: { file: string; error: string }[];
}

/** Progress emitted on the `send-progress` event. */
export interface SendProgress {
  file: string;
  index: number;
  total: number;
}

export const sendConfig = () => invoke<DeliveryStatus>("send_config");

/**
 * Save delivery settings. Pass `password: null` to leave the stored one alone,
 * or an empty string to forget it.
 */
export const saveSendConfig = (config: DeliveryConfig, password: string | null) =>
  invoke<DeliveryStatus>("save_send_config", { config, password });

export const sendTestEmail = () => invoke<void>("send_test_email");

export const sendFiles = (paths: string[]) =>
  invoke<SendReport>("send_files", { paths });

/**
 * Server settings for the providers people actually use, so nobody has to go
 * hunting for a port number. Ports and TLS modes are not interchangeable —
 * 587 wants STARTTLS and 465 wants TLS — which is a common way to get stuck.
 */
/** Labels are brand names and stay as-is in every language; `note` is the
 * only part of this worth translating, so this is a function of `t` like
 * `compressionPresets` in `lib/settings.ts`. */
export const presets = (
  t: Translator,
): { label: string; host: string; port: number; security: string; note?: string }[] => [
  {
    label: "Gmail",
    host: "smtp.gmail.com",
    port: 587,
    security: "start-tls",
    note: t("send.noteGmail"),
  },
  {
    label: "Outlook / Hotmail",
    host: "smtp-mail.outlook.com",
    port: 587,
    security: "start-tls",
    note: t("send.noteOutlook"),
  },
  {
    label: "Yahoo",
    host: "smtp.mail.yahoo.com",
    port: 465,
    security: "tls",
    note: t("send.noteYahoo"),
  },
  {
    label: "iCloud",
    host: "smtp.mail.me.com",
    port: 587,
    security: "start-tls",
    note: t("send.noteICloud"),
  },
];

/** True once there is enough configured for a send to be worth attempting. */
export const isConfigured = (status: DeliveryStatus | null) =>
  status !== null &&
  status.config.kindle_email.trim() !== "" &&
  status.config.from.trim() !== "" &&
  status.config.host.trim() !== "";
