// Better Auth 핸들러 마운트 (T03). /api/auth/* 전체를 catch-all로 위임.
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
