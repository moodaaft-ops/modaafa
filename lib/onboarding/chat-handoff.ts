/**
 * Hand-off from onboarding to the chat (task 05 owns the chat screen).
 *
 * Contract, agreed in principle with task 05: onboarding links to
 * /assistant?from=onboarding once the first audit has a result. The chat may
 * read `from` to open with the first findings; an unknown or missing value must
 * change nothing, so this link is safe before task 05 ships.
 */
export const CHAT_HANDOFF_PATH = '/assistant?from=onboarding';
