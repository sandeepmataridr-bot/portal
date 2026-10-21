class RuleError(Exception):
    """A rule failed to lex, parse, type-check or compile."""

    def __init__(self, message: str, source: str = "<rule>", line: int = 0, col: int = 0):
        super().__init__(message)
        self.message = message
        self.source = source
        self.line = line
        self.col = col

    def __str__(self) -> str:
        loc = f"{self.source}:{self.line}:{self.col}" if self.line else self.source
        return f"{loc}: {self.message}"
