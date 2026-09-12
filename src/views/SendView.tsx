import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, Send, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import {
  PRESETS,
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
      const preset = PRESETS.find((p) => p.label === label);
      if (preset) {
        patch({ host: preset.host, port: preset.port, security: preset.security });
      }
    },
    [patch],
  );

  const preset = config
    ? PRESETS.find((p) => p.host === config.host && p.port === config.port)
    : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card/60 px-4 py-2.5">
        <h1 className="flex-1 text-sm font-semibold">Send to Kindle</h1>
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
          {tested ? "Test sent" : "Send test"}
        </Button>
        <Button onClick={() => void save()} disabled={!config || saving}>
          {saving ? <Loader2 className="animate-spin" /> : saved ? <Check /> : null}
          {saved ? "Saved" : "Save"}
        </Button>
      </header>

      <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {!config ? (
          <div className="flex items-center gap-2 p-5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
            {/* The failure nothing can detect, stated before it happens. */}
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <div>
                <p className="font-medium">
                  Amazon only accepts mail from an address you have approved.
                </p>
                <p className="mt-0.5 leading-relaxed text-muted-foreground">
                  Add the <span className="text-foreground">sender address</span>{" "}
                  below to your Approved Personal Document E-mail List, or Amazon
                  discards the message without a bounce — a successful send here
                  will still never arrive.
                </p>
                <a
                  href="https://www.amazon.com/hz/mycd/digital-console/alldevices"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                >
                  <ExternalLink className="size-3" />
                  Manage Your Content and Devices → Preferences
                </a>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kindle">Device address</Label>
              <Input
                id="kindle"
                value={config.kindle_email}
                placeholder="something@kindle.com"
                onChange={(e) => patch({ kindle_email: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">
                Found under the same Amazon page, per device.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="from">Sender address</Label>
              <Input
                id="from"
                value={config.from}
                placeholder="you@gmail.com"
                onChange={(e) => patch({ from: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">
                This is the one Amazon must have approved.
              </p>
            </div>

            <Separator />

            <div className="flex flex-col gap-1.5">
              <Label>Mail provider</Label>
              <Select value={preset?.label ?? ""} onValueChange={applyPreset}>
                <SelectTrigger className="w-60">
                  <SelectValue placeholder="Choose one, or set it up by hand" />
                </SelectTrigger>
                <SelectContent>
                  {PRESETS.map((p) => (
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

            <div className="flex gap-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="host">Server</Label>
                <Input
                  id="host"
                  value={config.host}
                  placeholder="smtp.gmail.com"
                  onChange={(e) => patch({ host: e.target.value })}
                />
              </div>
              <div className="flex w-24 flex-col gap-1.5">
                <Label htmlFor="port">Port</Label>
                <Input
                  id="port"
                  type="number"
                  value={config.port}
                  onChange={(e) => patch({ port: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="flex w-40 flex-col gap-1.5">
                <Label htmlFor="security">Encryption</Label>
                <Select
                  value={config.security}
                  onValueChange={(v) => patch({ security: v })}
                >
                  <SelectTrigger id="security">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="start-tls">STARTTLS · 587</SelectItem>
                    <SelectItem value="tls">TLS · 465</SelectItem>
                    <SelectItem value="none">None</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex gap-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  value={config.username}
                  placeholder="you@gmail.com"
                  onChange={(e) => patch({ username: e.target.value })}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password ?? ""}
                  placeholder={
                    status?.has_password ? "Stored in your keychain" : "App password"
                  }
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              The password is kept in{" "}
              {navigator.platform.startsWith("Win")
                ? "Windows Credential Manager"
                : "the macOS Keychain"}
              , never in Mangalize's settings file. Leave the field blank to keep
              the stored one; clear it and save to forget it.
            </p>

            {tested && (
              <p className="flex items-center gap-1.5 text-xs text-primary">
                <Check className="size-3.5" />
                Your mail server accepted the message. If it does not reach the
                device, the sender address is not approved with Amazon.
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
