import net from "node:net";
import { Buffer } from "node:buffer";

export type EmailGatewaySettings = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  fromEmail: string;
};

export type SmsGatewaySettings = {
  username: string;
  password: string;
  senderId: string;
  departmentKey: string;
  templateId: string;
  postUrl: string;
};

export type TwilioGatewaySettings = {
  accountSid: string;
  authToken: string;
  fromNumber?: string;
  messagingServiceSid?: string;
};

export const DEFAULT_EMAIL_SUBJECT = "HP Tourism eServices – Test Email";
export const DEFAULT_EMAIL_BODY =
  "This is a test email from the HP Tourism eServices Super Admin console.";

export const DEFAULT_SMS_BODY =
  "{{OTP}} is your OTP for Himachal Tourism e-services portal registration. - Tourism Department";

const CRLF = "\r\n";

type SmtpResponse = {
  code: number;
  message: string;
};

const normalizeLineEndings = (text: string) =>
  text.replace(/\r?\n/g, CRLF).replace(/\n\./g, "\n..");

const readSmtpResponse = (
  socket: net.Socket,
  timeoutMs = 15000,
): Promise<SmtpResponse> => {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const lines: string[] = [];

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onTimeout = () => {
      cleanup();
      reject(new Error("SMTP connection timed out"));
    };

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      while (true) {
        const idx = buffer.indexOf(CRLF);
        if (idx === -1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + CRLF.length);
        lines.push(line);
        if (/^\d{3} /.test(line)) {
          cleanup();
          const code = parseInt(line.slice(0, 3), 10);
          resolve({ code, message: lines.join("\n") });
          return;
        }
      }
    };

    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.on("data", onData);
    socket.setTimeout(timeoutMs);
  });
};

const sendSmtpCommand = async (
  socket: net.Socket,
  command: string,
  expectedCodes: number[],
  log: string[],
) => {
  log.push(`> ${command}`);
  socket.write(`${command}${CRLF}`);
  const response = await readSmtpResponse(socket);
  log.push(`< ${response.message}`);
  if (!expectedCodes.includes(response.code)) {
    throw new Error(`SMTP command "${command}" failed with ${response.code}`);
  }
};

export const sendTestEmail = async (
  config: EmailGatewaySettings,
  payload: { to: string; subject?: string; body?: string },
) => {
  if (!config.host || !config.port || !config.fromEmail) {
    throw new Error("SMTP configuration incomplete");
  }

  const log: string[] = [];
  const socket = net.createConnection({
    host: config.host,
    port: Number(config.port) || 25,
  });

  try {
    log.push(`Connecting to ${config.host}:${config.port}`);
    const greeting = await readSmtpResponse(socket);
    log.push(`< ${greeting.message}`);
    if (greeting.code !== 220) {
      throw new Error(`SMTP greeting failed with ${greeting.code}`);
    }

    await sendSmtpCommand(socket, `EHLO hp-tourism-portal`, [250], log);

    if (config.username && config.password) {
      await sendSmtpCommand(socket, "AUTH LOGIN", [334], log);
      await sendSmtpCommand(
        socket,
        Buffer.from(config.username).toString("base64"),
        [334],
        log,
      );
      await sendSmtpCommand(
        socket,
        Buffer.from(config.password).toString("base64"),
        [235],
        log,
      );
    }

    const fromAddress = config.fromEmail;
    await sendSmtpCommand(socket, `MAIL FROM:<${fromAddress}>`, [250], log);
    await sendSmtpCommand(socket, `RCPT TO:<${payload.to}>`, [250, 251], log);
    await sendSmtpCommand(socket, "DATA", [354], log);

    const subject = payload.subject || DEFAULT_EMAIL_SUBJECT;
    const body = normalizeLineEndings(payload.body || DEFAULT_EMAIL_BODY);
    const message = [
      `From: ${fromAddress}`,
      `To: ${payload.to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      body,
      ".",
    ].join(CRLF);

    socket.write(`${message}${CRLF}`);
    const dataResponse = await readSmtpResponse(socket);
    log.push(`< ${dataResponse.message}`);
    if (dataResponse.code !== 250) {
      throw new Error(`SMTP DATA failed with ${dataResponse.code}`);
    }

    await sendSmtpCommand(socket, "QUIT", [221], log);
    return { log };
  } finally {
    socket.end();
  }
};

export const sendTestSms = async (
  config: SmsGatewaySettings,
  payload: { mobile: string; message: string },
) => {
  const debugParams = {
    username: config.username,
    senderId: config.senderId,
    departmentKeyPreview: config.departmentKey ? `${config.departmentKey.slice(0, 4)}…` : null,
    templateId: config.templateId,
    postUrl: config.postUrl,
    hasPassword: Boolean(config.password),
  };
  if (
    !config.username ||
    !config.password ||
    !config.senderId ||
    !config.departmentKey ||
    !config.templateId ||
    !config.postUrl
  ) {
    throw new Error("SMS configuration incomplete");
  }

  const params = new URLSearchParams();
  params.set("username", config.username);
  params.set("password", config.password);
  params.set("senderid", config.senderId);
  params.set("deptsecurekey", config.departmentKey);
  params.set("deptSecureKey", config.departmentKey);
  params.set("templateid", config.templateId);
  params.set("content", payload.message);
  params.set("mobileno", payload.mobile);
  params.set("smsservicetype", "singlemessage");

  console.log("[nic-sms] request", debugParams);
  const response = await fetch(config.postUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const text = await response.text();
  console.log("[nic-sms] response", response.status, text?.slice(0, 200));
  return {
    status: response.status,
    ok: response.ok,
    body: text,
  };
};

export const sendTwilioSms = async (
  config: TwilioGatewaySettings,
  payload: { mobile: string; message: string },
) => {
  if (!config.accountSid || !config.authToken) {
    throw new Error("Twilio configuration incomplete");
  }
  if (!config.fromNumber && !config.messagingServiceSid) {
    throw new Error("Provide a Twilio From Number or Messaging Service SID");
  }

  const params = new URLSearchParams();
  const normalizedMobile = (() => {
    const digits = payload.mobile.replace(/\s+/g, "");
    if (digits.startsWith("+")) {
      return digits;
    }
    if (/^[0-9]{10}$/.test(digits)) {
      return `+91${digits}`;
    }
    return digits;
  })();
  params.set("To", normalizedMobile);
  params.set("Body", payload.message);
  if (config.messagingServiceSid) {
    params.set("MessagingServiceSid", config.messagingServiceSid);
  } else if (config.fromNumber) {
    params.set("From", config.fromNumber);
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
      },
      body: params,
    },
  );

  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    body: text || (response.ok ? "Message queued via Twilio" : ""),
  };
};
