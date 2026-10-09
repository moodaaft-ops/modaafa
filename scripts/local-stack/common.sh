# shellcheck shell=bash
# Shared helpers. Sourced by up.sh, app.sh, verify.sh and down.sh.

# Variables that carry no application secret and are needed to reach npm/fonts through a proxy.
CLEAN_PASS_THROUGH=(HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy
  NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR CURL_CA_BUNDLE REQUESTS_CA_BUNDLE
  npm_config_cache NPM_CONFIG_CACHE)

# clean_env VAR=value ... command args...   runs with an empty environment plus the few names above,
# so nothing inherited from the caller's shell (keys, tokens, DATABASE_URL, NODE_ENV) reaches the child.
clean_env() {
  local args=(PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}")
  local name
  for name in "${CLEAN_PASS_THROUGH[@]}"; do
    if [ -n "${!name:-}" ]; then args+=("$name=${!name}"); fi
  done
  env -i "${args[@]}" "$@"
}

# with_stack_env command args...   same as clean_env, plus the generated .local-stack/env file.
with_stack_env() {
  clean_env STACK_ENV_FILE="$STATE/env" bash -c 'set -a; . "$STACK_ENV_FILE"; set +a; unset STACK_ENV_FILE; exec "$@"' _ "$@"
}
