class DomainError(Exception):
    status_code = 400


class BotNotFoundError(DomainError):
    status_code = 404


class ConflictError(DomainError):
    status_code = 409


class AdapterUnavailableError(DomainError):
    status_code = 404


class OperationError(DomainError):
    status_code = 500

