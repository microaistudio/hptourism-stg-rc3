import { useEffect, useState, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { getDefaultRouteForRole } from "@/config/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Mountain, Loader2, RefreshCw } from "lucide-react";
import { NavigationHeader } from "@/components/navigation-header";
import type { User } from "@shared/schema";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

type LoginAuthMode = "password" | "otp";
type OtpChannel = "sms" | "email";

const loginSchema = z
  .object({
    identifier: z.string().min(3, "Enter username, mobile number, or email"),
    password: z.string().optional(),
    captchaAnswer: z.string().optional(),
    authMode: z.enum(["password", "otp"]),
    otpChannel: z.enum(["sms", "email"]).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.authMode === "password" && (!data.password || data.password.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: "Password is required",
      });
    }
    if (data.authMode === "otp" && !data.otpChannel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["otpChannel"],
        message: "Choose where to receive the OTP",
      });
    }
  });

type LoginForm = z.infer<typeof loginSchema>;

type OtpChallengeState = {
  id: string;
  expiresAt: string;
  channel: OtpChannel;
  maskedMobile?: string;
  maskedEmail?: string;
};

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      identifier: "",
      password: "",
      captchaAnswer: "",
      authMode: "password",
      otpChannel: "sms",
    },
  });
  const [captchaQuestion, setCaptchaQuestion] = useState<string>("");
  const [captchaLoading, setCaptchaLoading] = useState<boolean>(false);
  const [captchaEnabled, setCaptchaEnabled] = useState<boolean>(true);
  const [otpChallenge, setOtpChallenge] = useState<OtpChallengeState | null>(null);
  const [otpValue, setOtpValue] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpOptionEnabled, setOtpOptionEnabled] = useState(false);
  const [otpChannels, setOtpChannels] = useState<{ sms: boolean; email: boolean }>({ sms: true, email: true });
  const [loginOptionsLoaded, setLoginOptionsLoaded] = useState(false);
  const [otpRequired, setOtpRequired] = useState(false);
  const authMode = form.watch("authMode");

  const ensureValidOtpChannel = (preferred?: OtpChannel) => {
    const current = preferred ?? form.getValues("otpChannel");
    if (current && otpChannels[current]) {
      form.setValue("otpChannel", current, { shouldValidate: false });
      return;
    }
    if (otpChannels.sms) {
      form.setValue("otpChannel", "sms", { shouldValidate: false });
      return;
    }
    if (otpChannels.email) {
      form.setValue("otpChannel", "email", { shouldValidate: false });
      return;
    }
    form.setValue("otpChannel", undefined as unknown as OtpChannel, { shouldValidate: false });
  };

  const handleAuthModeChange = (mode: LoginAuthMode) => {
    if (authMode === mode) {
      return;
    }
    setOtpChallenge(null);
    setOtpValue("");
    setOtpError(null);
    form.setValue("authMode", mode, { shouldValidate: false });
    if (mode === "otp") {
      form.setValue("password", "");
      form.clearErrors("password");
      ensureValidOtpChannel();
    }
  };

  const refreshCaptcha = useCallback(async () => {
    try {
      setCaptchaLoading(true);
      const response = await apiRequest("GET", "/api/auth/captcha");
      const data = await response.json();
      if (data.enabled === false) {
        setCaptchaEnabled(false);
        setCaptchaQuestion("");
        form.setValue("captchaAnswer", "");
        return;
      }
      setCaptchaEnabled(true);
      setCaptchaQuestion(data.question);
      form.setValue("captchaAnswer", "");
    } catch (error) {
      toast({
        title: "Captcha unavailable",
        description: (error as Error)?.message || "Unable to load captcha. Please try again.",
        variant: "destructive",
      });
    } finally {
      setCaptchaLoading(false);
    }
  }, [form, toast]);

  useEffect(() => {
    void refreshCaptcha();
  }, [refreshCaptcha]);

  useEffect(() => {
    let cancelled = false;
    const loadOptions = async () => {
      try {
        const response = await apiRequest("GET", "/api/auth/login/options");
        const data = await response.json();
        if (!cancelled) {
          const smsEnabled = Boolean(data?.smsOtpEnabled);
          const emailEnabled = Boolean(data?.emailOtpEnabled);
          const anyOtpChannel = smsEnabled || emailEnabled;
          setOtpChannels({ sms: smsEnabled, email: emailEnabled });
          setOtpOptionEnabled(anyOtpChannel);
          const isOtpRequired = Boolean(data?.otpRequired);
          setOtpRequired(isOtpRequired);
          ensureValidOtpChannel(smsEnabled ? "sms" : emailEnabled ? "email" : undefined);
          setLoginOptionsLoaded(true);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("[auth] Failed to load login options", error);
          setOtpOptionEnabled(false);
          setLoginOptionsLoaded(true);
        }
      }
    };
    void loadOptions();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    ensureValidOtpChannel();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otpChannels.sms, otpChannels.email]);

  const loginMutation = useMutation({
    mutationFn: async (data: LoginForm) => {
      const response = await apiRequest("POST", "/api/auth/login", data);
      return response.json();
    },
    onSuccess: (data: { user?: User; otpRequired?: boolean; challengeId?: string; expiresAt?: string; maskedMobile?: string; maskedEmail?: string; channel?: OtpChannel }) => {
      if (data?.otpRequired && data.challengeId && data.expiresAt) {
        setOtpChallenge({
          id: data.challengeId,
          expiresAt: data.expiresAt,
          channel: data.channel ?? "sms",
          maskedMobile: data.maskedMobile,
          maskedEmail: data.maskedEmail,
        });
        setOtpValue("");
        setOtpError(null);
        toast({
          title: "OTP sent",
          description: `Enter the code sent to ${data.maskedMobile ?? data.maskedEmail ?? "your registered contact"}.`,
        });
        return;
      }
      if (!data?.user) {
        toast({
          title: "Login failed",
          description: "Unexpected response from server.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Welcome back!",
        description: "You have successfully logged in.",
      });
      const defaultRoute = getDefaultRouteForRole(data.user.role);
      setLocation(defaultRoute);
    },
    onError: (error: any) => {
      toast({
        title: "Login failed",
        description: error.message || "Invalid credentials",
        variant: "destructive",
      });
    },
  });
  const verifyOtpMutation = useMutation({
    mutationFn: async ({ otp }: { otp: string }) => {
      const response = await apiRequest("POST", "/api/auth/login/verify-otp", {
        challengeId: otpChallenge?.id,
        otp,
      });
      return response.json();
    },
    onSuccess: (data: { user: User }) => {
      toast({
        title: "Welcome back!",
        description: "OTP verified successfully.",
      });
      const defaultRoute = getDefaultRouteForRole(data.user.role);
      setLocation(defaultRoute);
    },
    onError: (error: any) => {
      setOtpError(error?.message || "OTP verification failed");
    },
  });

  const onSubmit = (data: LoginForm) => {
    if (otpChallenge) {
      return;
    }
    if (captchaEnabled && !data.captchaAnswer?.trim()) {
      form.setError("captchaAnswer", { message: "Please solve the security check" });
      return;
    }
    loginMutation.mutate(data, {
      onSettled: () => {
        if (captchaEnabled) {
          void refreshCaptcha();
        }
      },
    });
  };
  const handleOtpSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!otpChallenge) {
      return;
    }
    if (otpValue.trim().length !== 6) {
      setOtpError("Enter the 6-digit code sent to your phone.");
      return;
    }
    setOtpError(null);
    verifyOtpMutation.mutate({ otp: otpValue });
  };
  const handleOtpReset = () => {
    setOtpChallenge(null);
    setOtpValue("");
    setOtpError(null);
    void refreshCaptcha();
  };

  const otpExpiresAt = otpChallenge ? new Date(otpChallenge.expiresAt) : null;

  return (
    <div className="min-h-screen bg-background">
      <NavigationHeader 
        title="HP Tourism Portal"
        showBack={false}
        showHome={true}
      />
      <div className="flex items-center justify-center p-4 pt-8">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <div className="flex justify-center mb-4">
              <div className="w-12 h-12 bg-primary rounded-lg flex items-center justify-center">
                <Mountain className="w-7 h-7 text-primary-foreground" />
              </div>
            </div>
            <CardTitle className="text-2xl">HP Tourism Portal</CardTitle>
            <CardDescription>
              Sign in to manage your tourism registrations
            </CardDescription>
          </CardHeader>
          <CardContent>
            {otpChallenge ? (
              <form onSubmit={handleOtpSubmit} className="space-y-4">
                <div className="text-center text-sm text-muted-foreground">
                  Enter the 6-digit code sent to{" "}
                  <span className="font-medium text-foreground">
                    {otpChallenge.maskedMobile ?? otpChallenge.maskedEmail ?? "your registered contact"}
                  </span>
                  .
                </div>
                <div className="flex justify-center">
                  <InputOTP
                    maxLength={6}
                    value={otpValue}
                    onChange={(value) => {
                      setOtpValue(value.replace(/\D/g, ""));
                      setOtpError(null);
                    }}
                    autoFocus
                  >
                    <InputOTPGroup>
                      {[0, 1, 2, 3, 4, 5].map((slot) => (
                        <InputOTPSlot key={`otp-slot-${slot}`} index={slot} />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                {otpExpiresAt && (
                  <p className="text-xs text-center text-muted-foreground">
                    Expires at {otpExpiresAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                  </p>
                )}
                {otpError && <p className="text-sm text-center text-destructive">{otpError}</p>}
                <Button
                  type="submit"
                  className="w-full"
                  disabled={verifyOtpMutation.isPending || otpValue.length !== 6}
                >
                  {verifyOtpMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    "Verify OTP"
                  )}
                </Button>
                <button
                  type="button"
                  className="w-full text-center text-sm text-muted-foreground hover:underline"
                  onClick={handleOtpReset}
                >
                  Use a different account
                </button>
              </form>
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  {otpOptionEnabled && loginOptionsLoaded && (
                    <div className="flex items-center justify-center">
                      <div className="flex rounded-full border bg-muted/40 p-1 text-xs font-medium">
                        <Button
                          type="button"
                          variant={authMode === "password" ? "default" : "ghost"}
                          size="sm"
                          className={`rounded-full px-4 ${authMode === "password" ? "" : "!text-muted-foreground"}`}
                          onClick={() => handleAuthModeChange("password")}
                        >
                          Password
                        </Button>
                        <Button
                          type="button"
                          variant={authMode === "otp" ? "default" : "ghost"}
                          size="sm"
                          className={`rounded-full px-4 ${authMode === "otp" ? "" : "!text-muted-foreground"}`}
                          onClick={() => handleAuthModeChange("otp")}
                          disabled={!otpOptionEnabled}
                        >
                          OTP
                        </Button>
                      </div>
                    </div>
                  )}
                  <FormField
                    control={form.control}
                    name="authMode"
                    render={({ field }) => <input type="hidden" {...field} />}
                  />
                  <FormField
                    control={form.control}
                    name="identifier"
                    render={({ field }) => (
                      <FormItem>
                      <FormLabel>Username, Mobile Number, or Email</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="e.g., admin.rc, 9876543210, or owner@example.com"
                          data-testid="input-identifier"
                          {...field}
                        />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {otpOptionEnabled && authMode === "otp" && (
                    <FormField
                      control={form.control}
                      name="otpChannel"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Send OTP via</FormLabel>
                          <div className="grid grid-cols-2 gap-2">
                            {(["sms", "email"] as const).map((option) => (
                              <Button
                                type="button"
                                key={option}
                                variant={field.value === option ? "default" : "outline"}
                                className="w-full"
                                onClick={() => otpChannels[option] && field.onChange(option)}
                                disabled={!otpChannels[option]}
                              >
                                {option === "sms" ? "SMS" : "Email"}
                              </Button>
                            ))}
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  {authMode === "password" ? (
                    <FormField
                      control={form.control}
                      name="password"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Password</FormLabel>
                          <FormControl>
                            <Input
                              type="password"
                              placeholder="Enter password"
                              data-testid="input-password"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  ) : (
                    <div className="rounded-lg bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                      We will send a one-time password to your selected contact after you solve the captcha.
                    </div>
                  )}

                  {captchaEnabled ? (
                    <FormField
                      control={form.control}
                      name="captchaAnswer"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Security Check</FormLabel>
                          <div className="flex items-center gap-2">
                            <div className="flex-1">
                              <div className="mb-2 rounded border bg-muted/40 px-3 py-2 text-center text-base font-semibold">
                                {captchaQuestion ? (
                                  <>
                                    {captchaQuestion} <span className="text-sm font-normal text-muted-foreground">(solve)</span>
                                  </>
                                ) : (
                                  "Loading..."
                                )}
                              </div>
                              <FormControl>
                                <Input
                                  placeholder="Enter the answer"
                                  inputMode="numeric"
                                  disabled={captchaLoading || !captchaQuestion}
                                  {...field}
                                />
                              </FormControl>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() => void refreshCaptcha()}
                              disabled={captchaLoading}
                              aria-label="Refresh captcha"
                            >
                              {captchaLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                            </Button>
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  ) : (
                    <div className="rounded border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                      Captcha has been temporarily disabled for this environment.
                    </div>
                  )}

                  <Button
                    type="submit"
                    className="w-full"
                    disabled={loginMutation.isPending || (captchaEnabled && !captchaQuestion)}
                    data-testid="button-login"
                  >
                    {loginMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Signing in...
                      </>
                    ) : authMode === "otp" ? (
                      "Send OTP"
                    ) : (
                      "Sign In"
                    )}
                  </Button>

                  <div className="text-center text-sm text-muted-foreground">
                    Forgot your password?{" "}
                    <button
                      type="button"
                      className="font-semibold text-primary hover:underline"
                      onClick={() => setLocation("/password-reset")}
                    >
                      Reset it here
                    </button>
                  </div>

                  <div className="text-center text-sm">
                    <span className="text-muted-foreground">Don't have an account? </span>
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => setLocation("/register")}
                      data-testid="link-register"
                    >
                      Register here
                    </button>
                  </div>
                </form>
              </Form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
