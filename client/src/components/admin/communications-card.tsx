import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Send } from "lucide-react";

type EmailGatewayMode = "custom" | "nic" | "sendgrid";

type EmailProviderResponse = {
  host?: string;
  port?: number;
  username?: string;
  fromEmail?: string;
  passwordSet?: boolean;
};

type EmailGatewayResponse = {
  provider?: EmailGatewayMode;
  custom?: EmailProviderResponse;
  nic?: EmailProviderResponse;
  sendgrid?: EmailProviderResponse;
  updatedAt?: string | null;
  updatedBy?: string | null;
} | null;

type SmsGatewayMode = "nic" | "twilio";

type SmsGatewayResponse = {
  provider?: SmsGatewayMode;
  nic?: {
    username?: string;
    senderId?: string;
    departmentKey?: string;
    templateId?: string;
    postUrl?: string;
    passwordSet?: boolean;
  };
  twilio?: {
    accountSid?: string;
    fromNumber?: string;
    messagingServiceSid?: string;
    authTokenSet?: boolean;
  };
  updatedAt?: string | null;
  updatedBy?: string | null;
} | null;

type CommunicationsResponse = {
  email: EmailGatewayResponse;
  sms: SmsGatewayResponse;
};

type EmailProviderFormState = {
  host: string;
  port: string;
  username: string;
  fromEmail: string;
  password: string;
};

type EmailFormState = {
  provider: EmailGatewayMode;
  custom: EmailProviderFormState;
  nic: EmailProviderFormState;
  sendgrid: EmailProviderFormState;
};

type SmsFormState = {
  provider: SmsGatewayMode;
  nic: {
    username: string;
    password: string;
    senderId: string;
    departmentKey: string;
    templateId: string;
    postUrl: string;
  };
  twilio: {
    accountSid: string;
    authToken: string;
    fromNumber: string;
    messagingServiceSid: string;
  };
  testMobile: string;
  testMessage: string;
};

const DEFAULT_SMS_TEMPLATE_ID = "1007739248479536901";
const DEFAULT_SMS_MESSAGE =
  "123456 is your OTP for Himachal Tourism e-services portal registration. - Tourism Department";

export const CommunicationsCard = () => {
  const { toast } = useToast();
  const blankEmailProvider: EmailProviderFormState = {
    host: "",
    port: "25",
    username: "",
    fromEmail: "",
    password: "",
  };
  const [emailForm, setEmailForm] = useState<EmailFormState>({
    provider: "custom",
    custom: { ...blankEmailProvider },
    nic: { ...blankEmailProvider },
    sendgrid: { ...blankEmailProvider },
  });
  const [emailTestRecipient, setEmailTestRecipient] = useState("");
  const [emailTestLog, setEmailTestLog] = useState<string[]>([]);
  const [emailSecrets, setEmailSecrets] = useState({
    customPasswordSet: false,
    nicPasswordSet: false,
    sendgridPasswordSet: false,
  });

  const [smsForm, setSmsForm] = useState<SmsFormState>({
    provider: "nic",
    nic: {
      username: "",
      password: "",
      senderId: "",
      departmentKey: "",
      templateId: DEFAULT_SMS_TEMPLATE_ID,
      postUrl: "https://msdgweb.mgov.gov.in/esms/sendsmsrequestDLT",
    },
    twilio: {
      accountSid: "",
      authToken: "",
      fromNumber: "",
      messagingServiceSid: "",
    },
    testMobile: "+918091441005",
    testMessage: DEFAULT_SMS_MESSAGE,
  });
  const [smsSecrets, setSmsSecrets] = useState({
    nicPasswordSet: false,
    twilioAuthTokenSet: false,
  });
  const [smsTestResponse, setSmsTestResponse] = useState("");

  const mapEmailProfileToForm = (profile?: EmailProviderResponse | null): EmailProviderFormState => ({
    host: profile?.host ?? "",
    port: profile?.port ? String(profile.port) : "25",
    username: profile?.username ?? "",
    fromEmail: profile?.fromEmail ?? "",
    password: "",
  });

  const { data, isLoading, refetch } = useQuery<CommunicationsResponse>({
    queryKey: ["/api/admin/communications"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/admin/communications");
      return (await response.json()) as CommunicationsResponse;
    },
  });

  useEffect(() => {
    const emailSettings = data?.email;
    if (emailSettings) {
      const provider = emailSettings.provider ?? "custom";
      setEmailForm({
        provider,
        custom: mapEmailProfileToForm(emailSettings.custom),
        nic: mapEmailProfileToForm(emailSettings.nic),
        sendgrid: mapEmailProfileToForm(emailSettings.sendgrid),
      });
      setEmailSecrets({
        customPasswordSet: Boolean(emailSettings.custom?.passwordSet),
        nicPasswordSet: Boolean(emailSettings.nic?.passwordSet),
        sendgridPasswordSet: Boolean(emailSettings.sendgrid?.passwordSet),
      });
      const activeProfile =
        (emailSettings[
          provider as keyof Omit<EmailGatewayResponse, "provider" | "updatedAt" | "updatedBy">
        ] as EmailProviderResponse | undefined) ?? undefined;
      if (!emailTestRecipient && activeProfile?.fromEmail) {
        setEmailTestRecipient(activeProfile.fromEmail);
      }
    }
    const smsSettings = data?.sms;
    if (smsSettings) {
      const provider = smsSettings.provider ?? "nic";
      setSmsForm((prev) => ({
        ...prev,
        provider,
        nic: {
          username: smsSettings.nic?.username ?? "",
          password: "",
          senderId: smsSettings.nic?.senderId ?? "",
          departmentKey: smsSettings.nic?.departmentKey ?? "",
          templateId: smsSettings.nic?.templateId ?? DEFAULT_SMS_TEMPLATE_ID,
          postUrl: smsSettings.nic?.postUrl ?? prev.nic.postUrl,
        },
        twilio: {
          accountSid: smsSettings.twilio?.accountSid ?? "",
          authToken: "",
          fromNumber: smsSettings.twilio?.fromNumber ?? "",
          messagingServiceSid: smsSettings.twilio?.messagingServiceSid ?? "",
        },
        testMessage: prev.testMessage || DEFAULT_SMS_MESSAGE,
      }));
      setSmsSecrets({
        nicPasswordSet: Boolean(smsSettings.nic?.passwordSet),
        twilioAuthTokenSet: Boolean(smsSettings.twilio?.authTokenSet),
      });
    }
  }, [data, emailTestRecipient]);

  const saveEmailMutation = useMutation({
    mutationFn: async (payload: EmailFormState) =>
      apiRequest("PUT", "/api/admin/communications/email", payload),
    onSuccess: (_data, variables) => {
      toast({ title: "SMTP settings saved" });
      setEmailForm((prev) => ({
        ...prev,
        custom: { ...prev.custom, password: "" },
        nic: { ...prev.nic, password: "" },
        sendgrid: { ...prev.sendgrid, password: "" },
      }));
      setEmailSecrets((prev) => ({
        customPasswordSet: prev.customPasswordSet || Boolean(variables.custom.password),
        nicPasswordSet: prev.nicPasswordSet || Boolean(variables.nic.password),
        sendgridPasswordSet: prev.sendgridPasswordSet || Boolean(variables.sendgrid.password),
      }));
      refetch();
    },
    onError: (error: any) => {
      toast({
        title: "Failed to save SMTP settings",
        description: error?.message || "Unknown error",
        variant: "destructive",
      });
    },
  });

  const saveSmsMutation = useMutation({
    mutationFn: async (payload: any) => apiRequest("PUT", "/api/admin/communications/sms", payload),
    onSuccess: (_data, variables) => {
      toast({ title: "SMS settings saved" });
      setSmsForm((prev) => ({
        ...prev,
        nic: { ...prev.nic, password: "" },
        twilio: { ...prev.twilio, authToken: "" },
      }));
      setSmsSecrets((prev) => ({
        nicPasswordSet: prev.nicPasswordSet || Boolean(variables?.nic?.password),
        twilioAuthTokenSet: prev.twilioAuthTokenSet || Boolean(variables?.twilio?.authToken),
      }));
      refetch();
    },
    onError: (error: any) => {
      toast({
        title: "Failed to save SMS settings",
        description: error?.message || "Unknown error",
        variant: "destructive",
      });
    },
  });

  const testEmailMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/communications/email/test", {
        to: emailTestRecipient || activeEmailForm.fromEmail,
      });
      return (await response.json()) as { log?: string[] };
    },
    onSuccess: (payload) => {
      setEmailTestLog(payload?.log ?? []);
      toast({ title: "Test email sent (check logs below)" });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to send test email",
        description: error?.message || "Unknown error",
        variant: "destructive",
      });
    },
  });

  const testSmsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/communications/sms/test", {
        mobile: smsForm.testMobile,
        message: smsForm.testMessage || DEFAULT_SMS_MESSAGE,
      });
      return (await response.json()) as {
        response?: string;
        status?: number;
        success?: boolean;
      };
    },
    onSuccess: (payload) => {
      const formatted = [
        `Status: ${payload?.status ?? "—"}`,
        `Gateway accepted: ${payload?.success ? "yes" : "no"}`,
        "",
        payload?.response?.trim() || "No response body returned.",
      ].join("\n");
      setSmsTestResponse(formatted);
      toast({
        title: payload?.success ? "Test SMS accepted" : "Gateway returned an error",
        description: "See detailed response below.",
        variant: payload?.success ? "default" : "destructive",
      });
    },
    onError: (error: any) => {
      setSmsTestResponse(error?.message || "Unknown error");
      toast({
        title: "Failed to send test SMS",
        description: error?.message || "Unknown error",
        variant: "destructive",
      });
    },
  });

  const buildSmsPayload = () => {
    const nicPostUrl = smsForm.nic.postUrl.trim();
    const twilioFrom = smsForm.twilio.fromNumber.trim();
    const twilioMessagingSid = smsForm.twilio.messagingServiceSid.trim();
    return {
      provider: smsForm.provider,
      nic: {
        username: smsForm.nic.username.trim(),
        senderId: smsForm.nic.senderId.trim(),
        departmentKey: smsForm.nic.departmentKey.trim(),
        templateId: smsForm.nic.templateId.trim() || DEFAULT_SMS_TEMPLATE_ID,
        postUrl: nicPostUrl || "https://msdgweb.mgov.gov.in/esms/sendsmsrequestDLT",
        password: smsForm.nic.password || undefined,
      },
      twilio: {
        accountSid: smsForm.twilio.accountSid.trim(),
        fromNumber: twilioFrom || undefined,
        messagingServiceSid: twilioMessagingSid || undefined,
        authToken: smsForm.twilio.authToken || undefined,
      },
    };
  };

  const emailUpdatedAt = useMemo(() => {
    if (!data?.email?.updatedAt) return null;
    const parsed = new Date(data.email.updatedAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString();
  }, [data?.email?.updatedAt]);

  const smsUpdatedAt = useMemo(() => {
    if (!data?.sms?.updatedAt) return null;
    const parsed = new Date(data.sms.updatedAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString();
  }, [data?.sms?.updatedAt]);

  const disabled = isLoading;
  const emailPasswordHints: Record<EmailGatewayMode, boolean> = {
    custom: emailSecrets.customPasswordSet,
    nic: emailSecrets.nicPasswordSet,
    sendgrid: emailSecrets.sendgridPasswordSet,
  };
  const activeEmailProvider = emailForm.provider;
  const activeEmailForm = emailForm[activeEmailProvider];
  const activeEmailPasswordSet = emailPasswordHints[activeEmailProvider];

  const updateEmailProviderField = (
    provider: EmailGatewayMode,
    field: keyof EmailProviderFormState,
    value: string,
  ) => {
    setEmailForm((prev) => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        [field]: value,
      },
    }));
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Send className="w-5 h-5 text-primary" />
          <CardTitle>Communications Gateway</CardTitle>
        </div>
        <CardDescription>Configure SMTP and SMS gateways used for OTP/login flows</CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <div className="grid gap-6 md:grid-cols-2">
          {/* SMS configuration */}
          <div className="space-y-4 border rounded-lg p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">SMS Gateway</h3>
              {smsUpdatedAt && (
                <Badge variant="outline" className="text-xs">
                  Updated {smsUpdatedAt}
                </Badge>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <Label>Gateway Provider</Label>
                <Select
                  value={smsForm.provider}
                  onValueChange={(value: SmsGatewayMode) =>
                    setSmsForm((prev) => ({
                      ...prev,
                      provider: value,
                    }))
                  }
                  disabled={disabled || saveSmsMutation.isPending}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nic">NIC MSDG (Production)</SelectItem>
                    <SelectItem value="twilio">Twilio (Cloud fallback)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Use Twilio for E2E testing outside the state network. Switch back to NIC before going live.
                </p>
              </div>

              {smsForm.provider === "nic" && (
                <div className="space-y-3 rounded-lg border p-3 bg-muted/20">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Username</Label>
                      <Input
                        value={smsForm.nic.username}
                        onChange={(e) =>
                          setSmsForm((prev) => ({ ...prev, nic: { ...prev.nic, username: e.target.value } }))
                        }
                        placeholder="hpgovt-TACA"
                        disabled={disabled || saveSmsMutation.isPending}
                      />
                    </div>
                    <div>
                      <Label>
                        Password {smsSecrets.nicPasswordSet && "(leave blank to keep current)"}
                      </Label>
                      <Input
                        type="password"
                        value={smsForm.nic.password}
                        onChange={(e) =>
                          setSmsForm((prev) => ({ ...prev, nic: { ...prev.nic, password: e.target.value } }))
                        }
                        placeholder="••••••••"
                        disabled={disabled || saveSmsMutation.isPending}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Sender ID</Label>
                      <Input
                        value={smsForm.nic.senderId}
                        onChange={(e) =>
                          setSmsForm((prev) => ({ ...prev, nic: { ...prev.nic, senderId: e.target.value } }))
                        }
                        placeholder="hpgovt"
                        disabled={disabled || saveSmsMutation.isPending}
                      />
                    </div>
                    <div>
                      <Label>Department Key</Label>
                      <Input
                        value={smsForm.nic.departmentKey}
                        onChange={(e) =>
                          setSmsForm((prev) => ({
                            ...prev,
                            nic: { ...prev.nic, departmentKey: e.target.value },
                          }))
                        }
                        placeholder="Secure key"
                        disabled={disabled || saveSmsMutation.isPending}
                      />
                    </div>
                  </div>
                  <div>
                    <Label>Template ID</Label>
                    <Input
                      value={smsForm.nic.templateId}
                      onChange={(e) =>
                        setSmsForm((prev) => ({ ...prev, nic: { ...prev.nic, templateId: e.target.value } }))
                      }
                      placeholder={DEFAULT_SMS_TEMPLATE_ID}
                      disabled={disabled || saveSmsMutation.isPending}
                    />
                  </div>
                  <div>
                    <Label>Gateway URL</Label>
                    <Input
                      value={smsForm.nic.postUrl}
                      onChange={(e) =>
                        setSmsForm((prev) => ({ ...prev, nic: { ...prev.nic, postUrl: e.target.value } }))
                      }
                      placeholder="https://msdgweb.mgov.gov.in/esms/sendsmsrequestDLT"
                      disabled={disabled || saveSmsMutation.isPending}
                    />
                  </div>
                </div>
              )}

              {smsForm.provider === "twilio" && (
                <div className="space-y-3 rounded-lg border p-3 bg-muted/20">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <Label>Account SID</Label>
                      <Input
                        value={smsForm.twilio.accountSid}
                        onChange={(e) =>
                          setSmsForm((prev) => ({
                            ...prev,
                            twilio: { ...prev.twilio, accountSid: e.target.value },
                          }))
                        }
                        placeholder="ACxxxxxxxxxxxx"
                        disabled={disabled || saveSmsMutation.isPending}
                      />
                    </div>
                    <div>
                      <Label>
                        Auth Token {smsSecrets.twilioAuthTokenSet && "(leave blank to keep current)"}
                      </Label>
                      <Input
                        type="password"
                        value={smsForm.twilio.authToken}
                        onChange={(e) =>
                          setSmsForm((prev) => ({
                            ...prev,
                            twilio: { ...prev.twilio, authToken: e.target.value },
                          }))
                        }
                        placeholder="●●●●●●"
                        disabled={disabled || saveSmsMutation.isPending}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <Label>From Number</Label>
                      <Input
                        value={smsForm.twilio.fromNumber}
                        onChange={(e) =>
                          setSmsForm((prev) => ({
                            ...prev,
                            twilio: { ...prev.twilio, fromNumber: e.target.value },
                          }))
                        }
                        placeholder="+15551234567"
                        disabled={disabled || saveSmsMutation.isPending}
                      />
                    </div>
                    <div>
                      <Label>Messaging Service SID (optional)</Label>
                      <Input
                        value={smsForm.twilio.messagingServiceSid}
                        onChange={(e) =>
                          setSmsForm((prev) => ({
                            ...prev,
                            twilio: { ...prev.twilio, messagingServiceSid: e.target.value },
                          }))
                        }
                        placeholder="MGxxxxxxxxxxxx"
                        disabled={disabled || saveSmsMutation.isPending}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        Provide a Messaging Service SID or a From Number.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <Button
                className="w-full"
                onClick={() => saveSmsMutation.mutate(buildSmsPayload())}
                disabled={saveSmsMutation.isPending}
              >
                {saveSmsMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...
                  </>
                ) : (
                  "Save SMS Settings"
                )}
              </Button>
            </div>
            <div className="pt-4 border-t space-y-3">
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <Label>Test mobile number</Label>
                  <Input
                    value={smsForm.testMobile}
                    onChange={(e) => setSmsForm({ ...smsForm, testMobile: e.target.value })}
                    placeholder="9876543210"
                    disabled={testSmsMutation.isPending}
                  />
                </div>
                <div>
                  <Label>Template message</Label>
                  <Textarea
                    value={smsForm.testMessage}
                    onChange={(e) => setSmsForm({ ...smsForm, testMessage: e.target.value })}
                    className="min-h-[90px]"
                    disabled={testSmsMutation.isPending}
                  />
                </div>
              </div>
              <Button
                variant="outline"
                onClick={() => testSmsMutation.mutate()}
                disabled={testSmsMutation.isPending || !smsForm.testMobile}
                className="w-full"
              >
                {testSmsMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Sending...
                  </>
                ) : (
                  "Send Test SMS"
                )}
              </Button>
              {smsTestResponse && (
                <div>
                  <Label>Gateway response</Label>
                  <Textarea
                    readOnly
                    className="font-mono text-xs min-h-[120px] mt-1"
                    value={smsTestResponse}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Email configuration */}
          <div className="space-y-4 border rounded-lg p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Email Gateway (SMTP)</h3>
              {emailUpdatedAt && (
                <Badge variant="outline" className="text-xs">
                  Updated {emailUpdatedAt}
                </Badge>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <Label>Gateway Provider</Label>
                <Select
                  value={emailForm.provider}
                  onValueChange={(value: EmailGatewayMode) =>
                    setEmailForm((prev) => ({
                      ...prev,
                      provider: value,
                    }))
                  }
                  disabled={disabled || saveEmailMutation.isPending}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="custom">Custom SMTP (LAN / Cloud)</SelectItem>
                    <SelectItem value="nic">NIC SMTP (Data Centre)</SelectItem>
                    <SelectItem value="sendgrid">Twilio SendGrid</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Keep NIC + SendGrid credentials on standby and switch instantly during cutovers.
                </p>
              </div>
              <div className="space-y-3 rounded-lg border p-3 bg-muted/20">
                <div>
                  <Label>From Email / Sender</Label>
                  <Input
                    value={activeEmailForm.fromEmail}
                    onChange={(e) =>
                      updateEmailProviderField(activeEmailProvider, "fromEmail", e.target.value)
                    }
                    placeholder="tourism-eservices@hp.gov.in"
                    disabled={disabled || saveEmailMutation.isPending}
                  />
                </div>
                <div>
                  <Label>SMTP Username (optional)</Label>
                  <Input
                    value={activeEmailForm.username}
                    onChange={(e) =>
                      updateEmailProviderField(activeEmailProvider, "username", e.target.value)
                    }
                    placeholder={activeEmailProvider === "sendgrid" ? "apikey" : "tourism-eservices@hp.gov.in"}
                    disabled={disabled || saveEmailMutation.isPending}
                  />
                </div>
                <div>
                  <Label>
                    SMTP Password {activeEmailPasswordSet && "(leave blank to keep current)"}
                  </Label>
                  <Input
                    type="password"
                    value={activeEmailForm.password}
                    onChange={(e) =>
                      updateEmailProviderField(activeEmailProvider, "password", e.target.value)
                    }
                    placeholder="••••••••"
                    disabled={disabled || saveEmailMutation.isPending}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>SMTP Host</Label>
                    <Input
                      value={activeEmailForm.host}
                      onChange={(e) =>
                        updateEmailProviderField(activeEmailProvider, "host", e.target.value)
                      }
                      placeholder={
                        activeEmailProvider === "sendgrid"
                          ? "smtp.sendgrid.net"
                          : activeEmailProvider === "nic"
                            ? "10.241.8.51"
                            : "smtp.yourdomain.in"
                      }
                      disabled={disabled || saveEmailMutation.isPending}
                    />
                  </div>
                  <div>
                    <Label>Port</Label>
                    <Input
                      value={activeEmailForm.port}
                      onChange={(e) =>
                        updateEmailProviderField(activeEmailProvider, "port", e.target.value)
                      }
                      placeholder={activeEmailProvider === "sendgrid" ? "587" : "25"}
                      disabled={disabled || saveEmailMutation.isPending}
                    />
                  </div>
                </div>
              </div>
              <Button
                className="w-full"
                onClick={() => saveEmailMutation.mutate(emailForm)}
                disabled={saveEmailMutation.isPending}
              >
                {saveEmailMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...
                  </>
                ) : (
                  "Save Email Settings"
                )}
              </Button>
            </div>
            <div className="pt-4 border-t space-y-3">
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <Label>Test recipient</Label>
                  <Input
                    value={emailTestRecipient}
                    onChange={(e) => setEmailTestRecipient(e.target.value)}
                    placeholder="test@example.com"
                    disabled={testEmailMutation.isPending}
                  />
                </div>
              </div>
              <Button
                variant="outline"
                onClick={() => testEmailMutation.mutate()}
                disabled={testEmailMutation.isPending || !emailTestRecipient}
                className="w-full"
              >
                {testEmailMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Sending...
                  </>
                ) : (
                  "Send Test Email"
                )}
              </Button>
              {emailTestLog.length > 0 && (
                <div>
                  <Label>SMTP Conversation</Label>
                  <Textarea
                    readOnly
                    className="font-mono text-xs min-h-[140px] mt-1"
                    value={emailTestLog.join("\n")}
                  />
                </div>
              )}
            </div>
          </div>


        </div>
      </CardContent>
    </Card>
  );
};
