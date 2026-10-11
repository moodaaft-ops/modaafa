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

# ---- Docker daemon selection -------------------------------------------------------------------
# One local daemon is chosen once, after the preflight, and every later step uses the same one:
#   pin_docker        (up.sh) resolve from DOCKER_HOST / DOCKER_CONTEXT / the current context, refuse
#                     remote endpoints, record the result in .local-stack/docker-host.
#   use_stack_docker  (verify.sh, down.sh) reuse the recorded daemon, even if this terminal has a
#                     different context. Without a record it resolves from the environment.
# Both only export DOCKER_HOST for the running script and its children, and drop DOCKER_CONTEXT so
# the two can never disagree. Neither runs `docker context use` or edits any Docker file, so the
# user's default context is untouched. Needs $HERE (this folder) and $STATE (.local-stack).
pin_docker() {
  local endpoint
  endpoint="$(node "$HERE/preflight.mjs" docker-endpoint)" || return 1
  export DOCKER_HOST="$endpoint"
  unset DOCKER_CONTEXT
  mkdir -p "$STATE"
  printf '%s\n' "$endpoint" >"$STATE/docker-host"
}

use_stack_docker() {
  local recorded=""
  if [ -r "$STATE/docker-host" ]; then recorded="$(head -n1 "$STATE/docker-host")"; fi
  case "$recorded" in
    unix://?* | npipe://?*)
      if [ -n "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" ] && [ "${DOCKER_HOST:-}" != "$recorded" ]; then
        echo "Using the Docker daemon that up.sh chose ($recorded), not the one in this shell." >&2
      fi
      export DOCKER_HOST="$recorded"
      unset DOCKER_CONTEXT
      ;;
    "")
      local endpoint
      endpoint="$(node "$HERE/preflight.mjs" docker-endpoint)" || return 1
      export DOCKER_HOST="$endpoint"
      unset DOCKER_CONTEXT
      ;;
    *)
      echo "$STATE/docker-host holds a value that is not a local socket. Refusing to use it." >&2
      return 1
      ;;
  esac
}
