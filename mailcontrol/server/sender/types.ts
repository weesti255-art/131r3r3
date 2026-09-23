import type { RejectCategory } from "../../shared/contracts.js";

export interface OutgoingMessage {
  from: { email: string; name: string };
  to: string;
  subject: string;
  text: string;
}

export interface SenderCredentials {
  email: string;
  password: string;
}

/** The single result contract every adapter maps onto; the queue knows nothing else. */
export type SendOutcome =
  | { kind: "accepted"; response: string }
  | {
      kind: "rejected";
      category: RejectCategory;
      code: string | null;
      message: string;
      /** Temporary failures at the recipient/message stage do not cool the account down. */
      scope?: "account" | "message";
    }
  | { kind: "unknown"; message: string };

export type CheckOutcome =
  | { kind: "ok"; response: string }
  | {
      kind: "rejected";
      category: Exclude<RejectCategory, "recipient" | "content_or_policy">;
      code: string | null;
      message: string;
    };

export interface Sender {
  readonly kind: "test" | "mail";
  send(
    credentials: SenderCredentials,
    message: OutgoingMessage
  ): Promise<SendOutcome>;
  /** Connection and login check without a letter. */
  check(credentials: SenderCredentials): Promise<CheckOutcome>;
}
