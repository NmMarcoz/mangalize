import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useT } from "@/lib/i18n";
import {
  presets,
  saveSendConfig,
  sendConfig,
  sendTestEmail,
  type DeliveryConfig,
  type DeliveryStatus,
} from "@/lib/send";

interface SendViewProps {
  onSaved: (status: DeliveryStatus) => void;
  onError: (message: string | null) => void;
}

/** Where a finished volume goes, and the mail account it travels on. */
export function SendView({ onSaved, onError }: SendViewProps) {
  const t = useT();
  const [status, setStatus] = useState<DeliveryStatus | null>(null);
  const [config, setConfig] = useState<DeliveryConfig | null>(null);
  /** `null` means "leave the stored password alone". */
  const [password, setPassword] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    sendConfig()
      .then((found) => {
        setStatus(found);
        setConfig(found.config);
      })
      .catch((e) => onError(String(e)));
  }, [onError]);

  const patch = useCallback((fields: Partial<DeliveryConfig>) => {
    setSaved(false);
    setTested(false);
    setConfig((current) => (current ? { ...current, ...fields } : current));
  }, []);

  const save = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    onError(null);
    try {
      const next = await saveSendConfig(config, password);
      setStatus(next);
      setConfig(next.config);
      setPassword(null);
      setSaved(true);
      onSaved(next);
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config, password, onSaved, onError]);

  const test = useCallback(async () => {
    setTesting(true);
    setTested(false);
    onError(null);
    try {
      // Save first, or the test checks the settings as they were last saved
      // rather than the ones on screen.
      if (config) {
        const next = await saveSendConfig(config, password);
        setStatus(next);
        setPassword(null);
      }
      await sendTestEmail();
      setTested(true);
    } catch (e) {
      onError(String(e));
    } finally {
      setTesting(false);
    }
  }, [config, password, onError]);

  const applyPreset = useCallback(
    (label: string) => {
      const preset = presets(t).find((p) => p.label === label);
      if (preset) {
        patch({ host: preset.host, port: preset.port, security: preset.security });
      }
    },
    [patch, t],
  );

  const preset = config
    ? presets(t).find((p) => p.host === config.host && p.port === config.port)
    : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card/60 px-5 py-3">
        <h1 className="flex-1 text-sm font-semibold">{t("sendView.title")}</h1>
        <Button
          variant="outline"
          onClick={() => void test()}
          disabled={!config || saving || testing}
        >
          {testing ? (
            <Loader2 className="animate-spin" />
          ) : tested ? (
            <Check />
          ) : (
            <Send />
          )}
          {tested ? t("sendView.testSent") : t("sendView.sendTest")}
        </Button>
        <Button onClick={() => void save()} disabled={!config || saving}>
          {saving ? <Loader2 className="animate-spin" /> : saved ? <Check /> : null}
          {saved ? t("sendView.saved") : t("sendView.save")}
        </Button>
      </header>

      <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {!config ? (
          <div className="flex items-center gap-2 p-5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> {t("sendView.loading")}
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-7 px-6 py-8">
            {/* The failure nothing can detect, stated before it happens. */}
            <Callout tone="warning" title={t("sendView.approvalWarningTitle")}>
              <p>
                {t("sendView.approvedBefore")}{" "}
                <span className="text-foreground">
                  {t("sendView.approvedEmphasis")}
                </span>{" "}
                {t("sendView.approvedAfter")}
              </p>
              <a
                href="https://www.amazon.com/hz/mycd/digital-console/alldevices"
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                <ExternalLink className="size-3" />
                {t("sendView.manageDevicesLink")}
              </a>
            </Callout>

            <div className="flex flex-col gap-2">
              <Label htmlFor="kindle">{t("sendView.deviceAddress")}</Label>
              <Input
                id="kindle"
                value={config.kindle_email}
                placeholder={t("sendView.deviceAddressPlaceholder")}
                onChange={(e) => patch({ kindle_email: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">
                {t("sendView.deviceAddressHint")}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="from">{t("sendView.senderAddress")}</Label>
              <Input
                id="from"
                value={config.from}
                placeholder={t("sendView.exampleAddress")}
                onChange={(e) => patch({ from: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">
                {t("sendView.senderAddressHint")}
              </p>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <Label>{t("sendView.mailProvider")}</Label>
              <Select value={preset?.label ?? ""} onValueChange={applyPreset}>
                <SelectTrigger className="w-60">
                  <SelectValue placeholder={t("sendView.mailProviderPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {presets(t).map((p) => (
                    <SelectItem key={p.label} value={p.label}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {preset?.note && (
                <p className="text-[11px] text-muted-foreground">{preset.note}</p>
              )}
            </div>

            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-2">
                <Label htmlFor="host">{t("sendView.server")}</Label>
                <Input
                  id="host"
                  value={config.host}
                  placeholder={t("sendView.serverPlaceholder")}
                  onChange={(e) => patch({ host: e.target.value })}
                />
              </div>
              <div className="flex w-24 flex-col gap-2">
                <Label htmlFor="port">{t("sendView.port")}</Label>
                <Input
                  id="port"
                  type="number"
                  value={config.port}
                  onChange={(e) => patch({ port: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="flex w-40 flex-col gap-2">
                <Label htmlFor="security">{t("sendView.encryption")}</Label>
                <Select
                  value={config.security}
                  onValueChange={(v) => patch({ security: v })}
                >
                  <SelectTrigger id="security">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="start-tls">
                      {t("sendView.encryptionStartTls")}
                    </SelectItem>
                    <SelectItem value="tls">{t("sendView.encryptionTls")}</SelectItem>
                    <SelectItem value="none">{t("sendView.encryptionNone")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex gap-3">
                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="username">{t("sendView.username")}</Label>
                  <Input
                    id="username"
                    value={config.username}
                    placeholder={t("sendView.exampleAddress")}
                    onChange={(e) => patch({ username: e.target.value })}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="password">{t("sendView.password")}</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password ?? ""}
                    placeholder={
                      status?.has_password
                        ? t("sendView.passwordStored")
                        : t("sendView.passwordPlaceholder")
                    }
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("sendView.passwordHint", {
                  keychain: navigator.platform.startsWith("Win")
                    ? t("sendView.windowsCredentialManager")
                    : t("sendView.macKeychain"),
                })}
              </p>
            </div>

            {tested && (
              <p className="flex items-center gap-1.5 text-xs text-primary">
                <Check className="size-3.5" />
                {t("sendView.testSuccess")}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
