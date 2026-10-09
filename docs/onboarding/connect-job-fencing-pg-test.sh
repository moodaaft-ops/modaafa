# Test only: needs a scratch Postgres with db/migrations/20261009_connect_job_fencing.sql applied, plus a minimal job_runs/businesses/google_ads_accounts schema. Never run against production.
set -u
P="psql -h /tmp -p 54999 -U pgt -d postgres -v ON_ERROR_STOP=1 -q -t -A"
U=11111111-1111-4111-8111-111111111111; B=22222222-2222-4222-8222-222222222222
pass=0; fail=0
ok(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1 (got '$2' want '$3')"; fi; }
reset(){ $P -c "truncate public.google_ads_accounts, public.job_runs cascade; delete from public.businesses; insert into public.businesses(id,user_id) values ('$B','$U');" >/dev/null; }
rows(){ echo "[{\"business_id\":\"$B\",\"customer_id\":\"$1\",\"customer_name\":\"x\",\"refresh_token_encrypted\":\"$2\",\"permissions_scope\":[\"adwords\"],\"status\":\"active\",\"is_manager\":false}]"; }
link(){ $P -c "select (public.connect_job_link('$1','$U','$B','$(rows 1234567890 $2)'::jsonb))->>'status';"; }
tok(){ $P -c "select coalesce(max(refresh_token_encrypted),'none') from public.google_ads_accounts;"; }

echo "--- 1: out of order (old job arrives after the new one)"
reset
A=$($P -c "select public.connect_job_start('$U'::uuid);"); Bj=$($P -c "select public.connect_job_start('$U');")
ok "old job status is failed after supersede" "$($P -c "select status from public.job_runs where id='$A';")" failed
ok "only one running job" "$($P -c "select count(*) from public.job_runs where status='running';")" 1
ok "NEW job links first" "$(link $Bj TOKEN_NEW)" linked
ok "OLD job link is refused" "$(link $A TOKEN_OLD)" superseded
ok "token stays the new one" "$(tok)" TOKEN_NEW
ok "OLD select refused" "$($P -c "select public.connect_job_select_account('$A','$U','$B','1234567890');")" superseded
ok "selection untouched by old job" "$($P -c "select coalesce(selected_google_ads_customer_id,'null') from public.businesses;")" null
ok "NEW select works" "$($P -c "select public.connect_job_select_account('$Bj','$U','$B','1234567890');")" selected
ok "OLD manager update refused" "$($P -c "select public.connect_job_set_manager('$A','$U',(select id from public.google_ads_accounts limit 1),'999');")" superseded
ok "old finish cannot flip to success" "$($P -c "with u as (update public.job_runs set status='success' where id='$A' and status='running' returning id) select count(*) from u;")" 0
ok "old row still failed" "$($P -c "select status from public.job_runs where id='$A';")" failed

echo "--- 2: old job links first, then new consent overwrites (newest wins)"
reset
A=$($P -c "select public.connect_job_start('$U'::uuid);")
ok "OLD links while live" "$(link $A TOKEN_OLD)" linked
Bj=$($P -c "select public.connect_job_start('$U'::uuid);")
ok "NEW links after" "$(link $Bj TOKEN_NEW)" linked
ok "final token is the newest" "$(tok)" TOKEN_NEW
ok "OLD cannot link again" "$(link $A TOKEN_OLD)" superseded
ok "final token still newest" "$(tok)" TOKEN_NEW

echo "--- 3: wrong user / foreign business"
reset
A=$($P -c "select public.connect_job_start('$U'::uuid);")
ok "other user's id cannot use the job" "$($P -c "select (public.connect_job_link('$A','33333333-3333-4333-8333-333333333333','$B','$(rows 1 T)'::jsonb))->>'status';")" superseded
ok "business not owned is forbidden" "$($P -c "select (public.connect_job_link('$A','$U','44444444-4444-4444-8444-444444444444','$(rows 1 T)'::jsonb))->>'status';")" forbidden
ok "no token written" "$(tok)" none

echo "--- 4: select does not override a user's own choice"
reset
$P -c "update public.businesses set selected_google_ads_customer_id='9999999999';" >/dev/null
A=$($P -c "select public.connect_job_start('$U'::uuid);")
ok "job keeps the user's choice" "$($P -c "select public.connect_job_select_account('$A','$U','$B','1234567890');")" kept

echo "--- 5: true concurrency, lock held by the old job while a new consent starts"
reset
A=$($P -c "select public.connect_job_start('$U'::uuid);")
( $P -c "begin; select public.connect_job_lock_live('$A','$U'); select pg_sleep(2); commit;" >/dev/null ) &
sleep 0.5
t0=$(date +%s%N)
Bj=$($P -c "select public.connect_job_start('$U'::uuid);")
t1=$(date +%s%N)
wait
ms=$(( (t1-t0)/1000000 ))
[ $ms -ge 1000 ] && ok "new start waited for the old job's lock (${ms}ms)" yes yes || ok "new start waited for the old job's lock (${ms}ms)" no yes
ok "old job refused after the new start" "$(link $A TOKEN_OLD)" superseded

echo "--- 6: stress, 40 rounds of old-link racing new-start+new-link"
bad=0
for i in $(seq 1 40); do
  reset
  A=$($P -c "select public.connect_job_start('$U'::uuid);")
  ( link $A TOKEN_OLD >/dev/null ) &
  ( Bj=$($P -c "select public.connect_job_start('$U'::uuid);"); link $Bj TOKEN_NEW >/dev/null ) &
  wait
  t=$(tok); r=$($P -c "select count(*) from public.job_runs where status='running';")
  # the new consent's link always lands last or the old one was refused: never OLD after NEW
  [ "$t" = "TOKEN_NEW" ] || bad=$((bad+1))
  [ "$r" = "1" ] || bad=$((bad+1))
done
ok "stress: final token always the newest, one running job (bad=$bad)" "$bad" 0

echo "--- 7: two callbacks at the same instant (no unique-index error, one winner)"
reset
( $P -c "select public.connect_job_start('$U'::uuid);" > /tmp/s1 2>&1 ) & ( $P -c "select public.connect_job_start('$U');" > /tmp/s2 2>&1 ) & wait
ok "both starts succeeded" "$(grep -c ERROR /tmp/s1 /tmp/s2 | awk -F: '{s+=$2} END{print s}')" 0
ok "exactly one running" "$($P -c "select count(*) from public.job_runs where status='running';")" 1
echo "--- 8: late callback of an OLDER consent is refused (ordering by consent time)"
reset
Bj=$($P -c "select public.connect_job_start('$U','2026-10-09T00:05:00Z');")
ok "newer consent links" "$(link $Bj TOKEN_NEW)" linked
late=$($P -c "select coalesce(public.connect_job_start('$U','2026-10-09T00:00:00Z')::text,'refused');")
ok "older consent arriving late is refused" "$late" refused
ok "newer job still running" "$($P -c "select status from public.job_runs where id='$Bj';")" running
ok "newer token untouched" "$(tok)" TOKEN_NEW
ok "refused start opened no job" "$($P -c "select count(*) from public.job_runs;")" 1
echo "--- 9: after the newer job finished, a late older consent is still refused"
$P -c "update public.job_runs set status='success' where id='$Bj';" >/dev/null
late=$($P -c "select coalesce(public.connect_job_start('$U','2026-10-09T00:00:00Z')::text,'refused');")
ok "older consent after newer success refused" "$late" refused
ok "token still the newer one" "$(tok)" TOKEN_NEW
echo "--- 10: no consent time falls back to arrival order"
reset
A=$($P -c "select public.connect_job_start('$U'::uuid);"); Bj=$($P -c "select public.connect_job_start('$U');")
ok "second arrival supersedes the first" "$($P -c "select status from public.job_runs where id='$A';")" failed
echo "RESULT pass=$pass fail=$fail"
