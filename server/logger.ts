import pino from "pino";
import pinoHttp from "pino-http";
import { randomUUID } from "crypto";
import { config } from "@shared/config";

const transport = config.logging.pretty
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        singleLine: false,
      },
    }
  : undefined;

export const logger = pino({
  level: config.logging.level,
  transport,
});

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const headerName = "x-request-id";
    const existingId =
      (req.headers[headerName] as string | undefined) ||
      (req.headers[headerName.toUpperCase()] as string | undefined);
    const id = existingId || randomUUID();
    res.setHeader(headerName, id);
    return id;
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) {
      return "error";
    }
    if (res.statusCode >= 400) {
      return "warn";
    }
    return "info";
  },
});
