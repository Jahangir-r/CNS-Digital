import crypto from "node:crypto";

export class TokenService {
  constructor(private readonly secret: string, private readonly clock: () => number = Date.now) {}

  issue(userId: number): string {
    const expiresAt = this.clock() + 43_200_000;
    const message = `${userId}.${expiresAt}`;
    const signature = crypto.createHmac("sha256", this.secret).update(message).digest("hex");
    return Buffer.from(`${message}.${signature}`).toString("base64url");
  }

  read(value?: string): number | null {
    if (!value) return null;
    try {
      const [idText, expiryText, supplied] = Buffer.from(value, "base64url").toString().split(".");
      const id = Number(idText), expiry = Number(expiryText);
      if (!Number.isInteger(id) || !Number.isFinite(expiry) || expiry < this.clock() || !supplied) return null;
      const expected = crypto.createHmac("sha256", this.secret).update(`${id}.${expiry}`).digest("hex");
      const left = Buffer.from(supplied, "hex"), right = Buffer.from(expected, "hex");
      return left.length === right.length && crypto.timingSafeEqual(left, right) ? id : null;
    } catch { return null; }
  }
}
