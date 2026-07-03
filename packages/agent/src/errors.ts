/** Base class for every error raised by @calledit/agent. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The model returned output we could not parse into the expected shape. */
export class AgentResponseFormatError extends AgentError {
  /** Raw model output kept for structured logging (PRD story 52). */
  readonly rawOutput: string;

  constructor(message: string, rawOutput: string) {
    super(message);
    this.rawOutput = rawOutput;
  }
}

/** The tool-use parse loop failed to produce a RawClaimParse. */
export class AgentParseError extends AgentError {}
