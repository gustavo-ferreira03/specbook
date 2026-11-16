import { CodedError } from "@specbook/runtime/errors";

import { browserFailureMessage } from "../jobs/presentation-errors";

export class BrowserUnavailableError extends CodedError {
  constructor(cause: unknown) {
    super("infrastructure", browserFailureMessage(cause), { cause });
    this.name = "BrowserUnavailableError";
  }
}
