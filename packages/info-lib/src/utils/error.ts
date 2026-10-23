export class LibError extends Error {
    constructor(message?: string) {
        super(message);
    }
}

export class LoginError extends LibError {
    constructor(message?: string) {
        super(message);
    }
}

export type LoginPreparationReason =
    | "missing-public-key"
    | "invalid-public-key"
    | "empty-response"
    | "access-restricted"
    | "gateway-unavailable"
    | "trust-limit"
    | "unexpected-page"
    | "unsafe-confirmation"
    | "confirmation-loop"
    /** 凭证入口被甩回校园网关自己的已登录界面（WebVPN 会话还活着）：
     *  网关因此不再发起 OAuth，入口拿不到统一认证表单。与「页面变体」区分开。 */
    | "gateway-session-pinned";

/** Safe, machine-readable login diagnostics. Never attach response HTML or session URLs. */
export class LoginPreparationError extends LoginError {
    readonly code = "AUTH_PREPARATION_FAILED";
    constructor(
        readonly reason: LoginPreparationReason,
        readonly stage: "credential-entry" | "trusted-confirmation" = "credential-entry",
    ) {
        super("Unable to prepare the university login form.");
        this.name = "LoginPreparationError";
    }
}

export class UrlError extends LibError {

}

export class ReportError extends LibError {
    constructor(message?: string) {
        super(message);
    }
}

export class ProgramError extends LibError {
    constructor(message?: string) {
        super(message);
    }
}

export class AssessmentError extends LibError {
    constructor(message?: string) {
        super(message);
    }
}

export class ClassroomStateError extends LibError {

}

export class EleError extends LibError {

}

export class LibraryError extends LibError {
    constructor(message?: string) {
        super(message);
    }
}

export class SportsError extends LibError {
    constructor(message?: string) {
        super(message);
    }
}

export class DormAuthError extends LibError {

}

export class IdAuthError extends LibError {

}

export class CabError extends LibError {

}

export class CabTimeoutError extends CabError {

}

export class CabNotActivatedError extends CabError {

}

export class UserInfoError extends LibError {

}

export class UseregAuthError extends LibError {

}

export class ResponseStatusError extends LibError {
    constructor(message?: string) {
        super(message);
    }
}

export class GitLabApiError extends LibError {

}

/** The server may have accepted the write before its response was lost or
 * malformed. Consumers should inspect current state before offering a retry. */
export class GitLabWriteOutcomeUnknownError extends GitLabApiError {
    readonly code = "GITLAB_WRITE_OUTCOME_UNKNOWN";
    readonly retryable = false;
    readonly writeOutcome = "unknown";
    constructor(cause: unknown) {
        super("The GitLab write result could not be confirmed. Refresh and check the resource before retrying.");
        this.name = "GitLabWriteOutcomeUnknownError";
        Object.defineProperty(this, "cause", {value: cause, enumerable: false});
    }
}

export class ScheduleError extends LibError {

}

export class CrError extends LibError {

}

export class CrCaptchaError extends CrError {

}

export class CrTimeoutError extends CrError {

}
