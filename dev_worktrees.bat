@echo off
rem =====================================================================
rem dev_worktrees.bat - one git worktree per parallel workstream, each
rem with its own database, its own Redis namespace, and its own Claude
rem Code window.
rem
rem WHY THIS EXISTS
rem   A fresh worktree is not a working checkout here: the four .env
rem   files are gitignored, node_modules is per-worktree, and the Prisma
rem   client is generated and gitignored too. And seed.js DELETES before
rem   it inserts, so if every worktree pointed at utility_cis the first
rem   seed would wipe the data every other window was looking at.
rem
rem ONE DEV STACK, ALWAYS
rem   stop_services.bat kills whatever listens on 4000 and 4001 by port,
rem   machine-wide, and start_dev.bat calls it first. A second worktree
rem   running start_dev.bat therefore kills the first one's servers
rem   whatever its own PORT says. Exactly one stream below has STACK set;
rem   the others are told in their brief never to run it.
rem
rem   4000/4001 and not 3000/3001: another application on this machine
rem   serves those, and a kill-by-port script aimed at them takes it down.
rem
rem POWERSHELL
rem   Three steps shell out to `powershell -NoProfile -Command`, the same
rem   way stop_services.bat does: rewriting a KEY=VALUE line in a .env,
rem   filling a brief template, and reading listening ports. A batch echo
rem   loop cannot rewrite those files without mangling em-dashes, blank
rem   lines and URL punctuation, and a BOM on line 1 of a .env turns
rem   DATABASE_URL into a key nothing reads.
rem
rem USAGE
rem   dev_worktrees.bat status            report what exists; change nothing
rem   dev_worktrees.bat up [stream]       create and provision, then launch
rem
rem   `up` starts the shared Postgres + Redis containers itself if they are
rem   not already running, and waits for Postgres to accept connections.
rem   You do not need to run start_db.bat first. `status` never starts
rem   anything - it reports db:unknown when the container is down.
rem   dev_worktrees.bat launch [stream]   open windows for existing worktrees
rem   dev_worktrees.bat down [stream]     remove worktrees
rem
rem FLAGS
rem   --skip-install    no pnpm install / prisma generate
rem   --skip-seed       create the database, do not seed it
rem   --skip-launch     provision without opening the windows
rem   --allow-dirty     create worktrees from a dirty main checkout
rem   --drop-databases  (down) drop each stream's database too
rem   --force           (down) remove a worktree holding unmerged work
rem
rem ENVIRONMENT (both have defaults; set them only to override)
rem   DW_ROOT         where worktrees live   (default C:\development\ucis-wt)
rem   DW_COORDINATOR  the coordinator session's name, written into each
rem                   brief  (default utility-cis-22 - see the note below)
rem
rem EXAMPLES
rem   dev_worktrees.bat status
rem   dev_worktrees.bat up
rem   dev_worktrees.bat up e2e --skip-seed
rem   dev_worktrees.bat down --drop-databases
rem =====================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "REPO=%CD%"

if not defined DW_ROOT set "DW_ROOT=C:\development\ucis-wt"

rem The coordinator's Claude session name - the window driving the main
rem checkout, which the streams report to with SendMessage. A session prints
rem its own name at the top of ListAgents ("This session is <name>").
rem
rem It is NOT derivable: the environment carries CLAUDE_CODE_SESSION_ID, a
rem UUID, while SendMessage addresses by name. And it changes when the
rem session restarts, so the value below goes stale - which is why each
rem brief also tells the stream to fall back to whichever session is running
rem in the main checkout. Override without editing this file:
rem   set DW_COORDINATOR=<name>
if not defined DW_COORDINATOR set "DW_COORDINATOR=utility-cis-22"

rem ---------------------------------------------------------------------
rem The streams. This table is the only thing to edit when the work
rem changes. A brief template per stream lives in scripts\briefs\<name>.md
rem ---------------------------------------------------------------------
set "STREAMS=ui seq e2e"

set "ui_BRANCH=feat/read-routes-ui"
set "ui_DB=utility_cis_ui"
set "ui_REDIS=1"
set "ui_PORT=4001"
set "ui_STACK=1"
set "ui_SEED=1"

set "seq_BRANCH=chore/drop-read-seq"
set "seq_DB=utility_cis_seq"
set "seq_REDIS=2"
set "seq_PORT=4011"
set "seq_STACK="
set "seq_SEED=1"

set "e2e_BRANCH=test/read-routes-e2e"
set "e2e_DB=utility_cis_e2e"
set "e2e_REDIS=3"
set "e2e_PORT=4021"
set "e2e_STACK="
set "e2e_SEED=1"

rem ---------------------------------------------------------------------
rem Arguments
rem ---------------------------------------------------------------------
set "ACTION="
set "ONLY="
set "SKIP_INSTALL="
set "SKIP_SEED="
set "SKIP_LAUNCH="
set "ALLOW_DIRTY="
set "DROP_DATABASES="
set "FORCE="

:parseargs
if "%~1"=="" goto argsdone
if /i "%~1"=="--skip-install"   ( set "SKIP_INSTALL=1"   & shift & goto parseargs )
if /i "%~1"=="--skip-seed"      ( set "SKIP_SEED=1"      & shift & goto parseargs )
if /i "%~1"=="--skip-launch"    ( set "SKIP_LAUNCH=1"    & shift & goto parseargs )
if /i "%~1"=="--allow-dirty"    ( set "ALLOW_DIRTY=1"    & shift & goto parseargs )
if /i "%~1"=="--drop-databases" ( set "DROP_DATABASES=1" & shift & goto parseargs )
if /i "%~1"=="--force"          ( set "FORCE=1"          & shift & goto parseargs )
if /i "%~1"=="-h"               ( goto usage )
if /i "%~1"=="--help"           ( goto usage )
if not defined ACTION ( set "ACTION=%~1" & shift & goto parseargs )
if not defined ONLY   ( set "ONLY=%~1"   & shift & goto parseargs )
echo Unknown argument: %~1
goto usage
:argsdone

if not defined ACTION set "ACTION=status"

if defined ONLY (
  echo %STREAMS% | findstr /i /c:"%ONLY%" >nul
  if errorlevel 1 (
    echo Unknown stream "%ONLY%". Known streams: %STREAMS%
    endlocal & exit /b 1
  )
  set "STREAMS=%ONLY%"
)

if /i "%ACTION%"=="status" goto act_status
if /i "%ACTION%"=="up"     goto act_up
if /i "%ACTION%"=="launch" goto act_launch
if /i "%ACTION%"=="down"   goto act_down
echo Unknown action "%ACTION%".
goto usage

:usage
echo.
echo   dev_worktrees.bat status^|up^|launch^|down [stream] [flags]
echo.
echo   Streams: %STREAMS%
echo   Flags:   --skip-install --skip-seed --skip-launch --allow-dirty
echo            --drop-databases --force
echo.
echo   Full notes are in the header of this file.
endlocal & exit /b 1


rem =====================================================================
rem STATUS
rem =====================================================================
:act_status
call :find_container
echo.
echo Main checkout
set "BASE="
for /f "usebackq delims=" %%b in (`git -C "%REPO%" rev-parse --abbrev-ref HEAD`) do set "BASE=%%b"
set /a DIRTY=0
for /f "usebackq delims=" %%d in (`git -C "%REPO%" status --porcelain`) do set /a DIRTY+=1
echo   %REPO% on !BASE!, !DIRTY! uncommitted file^(s^)

echo.
echo Streams
for %%s in (%STREAMS%) do (
  set "S=%%s"
  set "WT=%DW_ROOT%\%%s"
  set "WTSTATE=not created"
  if exist "!WT!\.git" set "WTSTATE=worktree ok"
  set "MODS=no"
  if exist "!WT!\node_modules" set "MODS=yes"
  set "DBSTATE=unknown"
  if defined CONTAINER (
    call :db_exists "!%%s_DB!"
    if errorlevel 1 ( set "DBSTATE=missing" ) else ( set "DBSTATE=present" )
  )
  echo   %%s  !WTSTATE!  db:!DBSTATE!  node_modules:!MODS!  !%%s_BRANCH!
)

echo.
echo Ports
powershell -NoProfile -Command "foreach($p in 4000,4001,5432,6379){$c=Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$n=(Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName; Write-Host ('  {0,-6} in use  pid {1} {2}' -f $p,$c.OwningProcess,$n)} else { Write-Host ('  {0,-6} free' -f $p) }}"

echo.
echo Playwright browser
if exist "%LOCALAPPDATA%\ms-playwright\chromium*" (
  echo   installed
) else (
  echo   NOT installed. Run: npx playwright install chromium
  echo   ^(managed Chrome cannot be driven by Playwright on this machine^)
)
echo.
endlocal & exit /b 0


rem =====================================================================
rem UP
rem =====================================================================
:act_up
echo.
echo Checks

set "BASE="
for /f "usebackq delims=" %%b in (`git -C "%REPO%" rev-parse --abbrev-ref HEAD`) do set "BASE=%%b"
if not defined BASE (
  echo   Not a git repository, or git is not on PATH.
  endlocal & exit /b 1
)
echo   base branch: !BASE!

set /a DIRTY=0
for /f "usebackq delims=" %%d in (`git -C "%REPO%" status --porcelain`) do set /a DIRTY+=1
if !DIRTY! GTR 0 if not defined ALLOW_DIRTY (
  echo.
  echo   The main checkout has !DIRTY! uncommitted file^(s^).
  echo   A worktree branches from the last COMMIT, so that work would be
  echo   missing from every stream - and one of them is told to build on it.
  echo.
  echo   Commit it first, or re-run with --allow-dirty.
  endlocal & exit /b 1
)

call :ensure_db
if errorlevel 1 (
  endlocal & exit /b 1
)
echo   database container: !CONTAINER! ^(ready^)

for %%t in (git pnpm node npx docker) do (
  where %%t >nul 2>nul
  if errorlevel 1 (
    echo   %%t is not on PATH.
    endlocal & exit /b 1
  )
)

if not exist "%DW_ROOT%" mkdir "%DW_ROOT%"

for %%s in (%STREAMS%) do (
  call :provision %%s
  if errorlevel 1 (
    echo.
    echo FAILED while provisioning %%s. Nothing further was attempted.
    endlocal & exit /b 1
  )
)

if defined SKIP_LAUNCH (
  echo.
  echo Not launching ^(--skip-launch^). To open them later:
  echo   dev_worktrees.bat launch
) else (
  call :launch_all
)

echo.
echo Done
echo   One dev stack only: start_dev.bat belongs to the ui stream.
echo   The coordinator ^(this checkout^) owns migrations and the plan file.
echo.
endlocal & exit /b 0


rem ---------------------------------------------------------------------
rem :provision <stream>
rem ---------------------------------------------------------------------
:provision
set "S=%~1"
set "WT=%DW_ROOT%\%S%"
set "BR=!%S%_BRANCH!"
set "DB=!%S%_DB!"
set "RDB=!%S%_REDIS!"
set "APIPORT=!%S%_PORT!"

echo.
echo Stream %S% -^> %WT%

rem --- 1. the worktree ---
if exist "%WT%\.git" (
  echo   [skip] worktree already exists
) else (
  git -C "%REPO%" rev-parse --verify --quiet "refs/heads/%BR%" >nul
  if errorlevel 1 (
    git -C "%REPO%" worktree add "%WT%" -b "%BR%" "%BASE%"
  ) else (
    echo   branch %BR% exists; attaching a worktree to it
    git -C "%REPO%" worktree add "%WT%" "%BR%"
  )
  if errorlevel 1 (
    echo   git worktree add failed.
    exit /b 1
  )
  echo   [ok] worktree created on %BR%
)

rem --- 2. the gitignored env files ---
call :copy_env ".env"                      "%WT%\.env"
call :copy_env "packages\api\.env"         "%WT%\packages\api\.env"
call :copy_env "packages\shared\.env"      "%WT%\packages\shared\.env"
call :copy_env "packages\web\.env.local"   "%WT%\packages\web\.env.local"
echo   [ok] env files in place

rem --- 3. point them at this stream's own database and Redis index ---
call :env_set_db    "%WT%\packages\api\.env"    DATABASE_URL          "%DB%"
call :env_set_db    "%WT%\packages\api\.env"    DATABASE_URL_PLATFORM "%DB%"
call :env_set_db    "%WT%\packages\shared\.env" DATABASE_URL          "%DB%"
call :env_set_redis "%WT%\packages\api\.env"    "%RDB%"
if not defined %S%_STACK call :env_set "%WT%\packages\api\.env" PORT "%APIPORT%"
echo   [ok] env points at %DB%, redis db %RDB%

rem --- 4. dependencies and the generated client ---
if defined SKIP_INSTALL (
  echo   [skip] pnpm install
) else (
  if exist "%WT%\node_modules" (
    echo   [skip] node_modules already present
  ) else (
    echo   pnpm install ^(slow^)
    pushd "%WT%"
    call pnpm install
    set "RC=!errorlevel!"
    popd
    if not "!RC!"=="0" (
      echo   pnpm install failed.
      exit /b 1
    )
    echo   [ok] dependencies installed
  )
  echo   prisma generate
  pushd "%WT%"
  call pnpm --filter @utility-cis/shared exec prisma generate
  set "RC=!errorlevel!"
  popd
  if not "!RC!"=="0" (
    echo   prisma generate failed.
    exit /b 1
  )
  echo   [ok] prisma client generated
)

rem --- 5. the database ---
call :db_exists "%DB%"
if errorlevel 1 (
  docker exec %CONTAINER% psql -U cis -d postgres -c "CREATE DATABASE \"%DB%\""
  if errorlevel 1 (
    echo   CREATE DATABASE %DB% failed.
    exit /b 1
  )
  echo   [ok] created database %DB%
) else (
  echo   [skip] database %DB% already exists
)

rem --- 6. migrate, with the URL passed explicitly. An inherited
rem        DATABASE_URL wins over a .env file, which is how work has
rem        gone to the wrong database here before.
set "URL="
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"DATABASE_URL=" "%WT%\packages\shared\.env"`) do set "URL=%%b"
if not defined URL (
  echo   Could not read DATABASE_URL from the worktree's packages\shared\.env
  exit /b 1
)
echo   prisma migrate deploy
call :migrate "%WT%" "%URL%"
if errorlevel 1 (
  echo   prisma migrate deploy failed.
  exit /b 1
)
echo   [ok] schema applied

rem --- 7. seed. seed_db.bat clears a stray DATABASE_URL itself and cds
rem        to its own directory, so the worktree's copy seeds the
rem        worktree's database.
if defined SKIP_SEED (
  echo   [skip] seed
) else (
  if not defined %S%_SEED (
    echo   [skip] seed
  ) else (
    echo   node seed.js ^(via seed_db.bat^)
    call "%WT%\seed_db.bat"
    if errorlevel 1 (
      echo   seeding failed.
      exit /b 1
    )
    echo   [ok] seeded
  )
)

rem --- 8. the brief and the launcher ---
call :write_brief "%S%" "%WT%"
call :write_launcher "%S%" "%WT%"
call :add_exclude "%WT%"
echo   [ok] BRIEF.md and .claude-start.cmd written ^(git-excluded^)
exit /b 0


rem =====================================================================
rem LAUNCH
rem =====================================================================
:act_launch
call :launch_all
endlocal & exit /b 0

:launch_all
echo.
echo Opening a console per stream
where wt.exe >nul 2>nul
set "HAVEWT=1"
if errorlevel 1 set "HAVEWT="
for %%s in (%STREAMS%) do (
  set "WT=%DW_ROOT%\%%s"
  if not exist "!WT!\.git" (
    echo   [skip] %%s: no worktree yet
  ) else (
    if not exist "!WT!\.claude-start.cmd" call :write_launcher "%%s" "!WT!"
    if defined HAVEWT (
      start "" wt.exe -w 0 nt --title %%s -d "!WT!" cmd /k "!WT!\.claude-start.cmd"
    ) else (
      start "claude: %%s" cmd /k "!WT!\.claude-start.cmd"
    )
    echo   [ok] %%s launched
  )
)
if not defined HAVEWT echo   Windows Terminal not found; used separate cmd windows.
exit /b 0


rem =====================================================================
rem DOWN
rem =====================================================================
:act_down
if defined DROP_DATABASES (
  call :find_container
  if not defined CONTAINER (
    echo No running utility-cis-db container; cannot drop databases.
    endlocal & exit /b 1
  )
)

for %%s in (%STREAMS%) do (
  set "S=%%s"
  set "WT=%DW_ROOT%\%%s"
  set "BR=!%%s_BRANCH!"
  set "DB=!%%s_DB!"
  echo.
  echo Removing stream %%s
  set "BLOCKED="

  if exist "!WT!\.git" (
    set /a WTDIRTY=0
    for /f "usebackq delims=" %%d in (`git -C "!WT!" status --porcelain`) do set /a WTDIRTY+=1
    set /a UNMERGED=0
    git -C "%REPO%" rev-parse --verify --quiet "refs/heads/!BR!" >nul
    if not errorlevel 1 (
      for /f "usebackq delims=" %%c in (`git -C "%REPO%" log --oneline "!BR!" --not HEAD`) do set /a UNMERGED+=1
    )
    if !WTDIRTY! GTR 0 set "BLOCKED=1"
    if !UNMERGED! GTR 0 set "BLOCKED=1"
    if defined FORCE set "BLOCKED="
    if defined BLOCKED (
      echo   !WTDIRTY! uncommitted file^(s^) and !UNMERGED! unmerged commit^(s^).
      echo   Left alone. Merge it, or re-run with --force to discard.
      set "BLOCKED="
    ) else (
      if defined FORCE (
        git -C "%REPO%" worktree remove "!WT!" --force
      ) else (
        git -C "%REPO%" worktree remove "!WT!"
      )
      if errorlevel 1 (
        echo   git worktree remove failed.
      ) else (
        echo   [ok] worktree removed
      )
    )
  ) else (
    echo   [skip] no worktree
  )

  if defined DROP_DATABASES (
    call :db_exists "!DB!"
    if errorlevel 1 (
      echo   [skip] !DB! not present
    ) else (
      docker exec !CONTAINER! psql -U cis -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='!DB!'" >nul
      docker exec !CONTAINER! psql -U cis -d postgres -c "DROP DATABASE IF EXISTS \"!DB!\""
      if errorlevel 1 ( echo   DROP DATABASE !DB! failed. ) else ( echo   [ok] dropped !DB! )
    )
  )
)

echo.
echo Branches are kept. Delete them yourself once merged:
for %%s in (%STREAMS%) do echo   git branch -d !%%s_BRANCH!
echo.
endlocal & exit /b 0


rem =====================================================================
rem Helpers
rem =====================================================================

rem :ensure_db
rem Starts the shared Postgres + Redis containers if they are not up, then
rem waits for Postgres to actually accept connections. `docker compose up -d`
rem returns as soon as the container is created, which is well before the
rem server is listening - so without the wait the first CREATE DATABASE
rem fails on a container that is, by every other measure, running.
rem
rem The containers are global: one pair serves every worktree, which is why
rem this is safe to call from any stream and why it is idempotent.
:ensure_db
call :find_container
if not defined CONTAINER (
  echo   no database container running; starting it
  call "%REPO%\start_db.bat"
  call :find_container
  if not defined CONTAINER (
    echo   docker compose up -d did not produce a utility-cis-db container.
    echo   Is Docker Desktop running?
    exit /b 1
  )
)
set /a DBWAIT=0
:waitdb
docker exec !CONTAINER! pg_isready -U cis -q
if not errorlevel 1 exit /b 0
set /a DBWAIT+=1
if !DBWAIT! GEQ 30 (
  echo   Postgres in !CONTAINER! did not accept connections within 30s.
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto waitdb

rem :find_container -> sets CONTAINER (empty when none is running)
:find_container
set "CONTAINER="
for /f "usebackq delims=" %%c in (`docker ps --filter "name=utility-cis-db" --format "{{.Names}}"`) do if not defined CONTAINER set "CONTAINER=%%c"
exit /b 0

rem :db_exists <name> -> errorlevel 0 present, 1 missing
:db_exists
set "FOUND="
for /f "usebackq delims=" %%r in (`docker exec %CONTAINER% psql -U cis -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='%~1'"`) do set "FOUND=%%r"
if "%FOUND%"=="1" exit /b 0
exit /b 1

rem :copy_env <relative source> <absolute destination>
:copy_env
if not exist "%REPO%\%~1" (
  echo   [skip] no %~1 to copy
  exit /b 0
)
if exist "%~2" (
  echo   [skip] %~2 already present
  exit /b 0
)
copy /y "%REPO%\%~1" "%~2" >nul
exit /b 0

rem :env_set <file> <key> <value>
rem UTF-8 with NO byte-order mark: a BOM on line 1 of a .env turns
rem DATABASE_URL into a key nothing reads.
:env_set
powershell -NoProfile -Command "$p='%~1';$k='%~2';$v='%~3';$l=[IO.File]::ReadAllLines($p);$done=$false;for($i=0;$i -lt $l.Length;$i++){if($l[$i] -match ('^\s*'+[regex]::Escape($k)+'\s*=')){$l[$i]=$k+'='+$v;$done=$true}};if(-not $done){$l=$l+($k+'='+$v)};[IO.File]::WriteAllLines($p,$l,(New-Object Text.UTF8Encoding($false)))"
exit /b 0

rem :env_set_db <file> <key> <database>
rem Swaps only the database segment of that key's URL, leaving user,
rem password, host and query string alone.
:env_set_db
powershell -NoProfile -Command "$p='%~1';$k='%~2';$d='%~3';$l=[IO.File]::ReadAllLines($p);for($i=0;$i -lt $l.Length;$i++){if($l[$i] -match ('^\s*'+[regex]::Escape($k)+'\s*=(.*)$')){$u=$Matches[1].Trim();$u=$u -replace '^([a-z]+://[^/]+/)[^?]*',('${1}'+$d);$l[$i]=$k+'='+$u}};[IO.File]::WriteAllLines($p,$l,(New-Object Text.UTF8Encoding($false)))"
exit /b 0

rem :env_set_redis <file> <index>
:env_set_redis
powershell -NoProfile -Command "$p='%~1';$n='%~2';$l=[IO.File]::ReadAllLines($p);for($i=0;$i -lt $l.Length;$i++){if($l[$i] -match '^\s*REDIS_URL\s*=(.*)$'){$u=$Matches[1].Trim();$u=$u -replace '^(redis://[^/]+)(/.*)?$',('${1}/'+$n);$l[$i]='REDIS_URL='+$u}};[IO.File]::WriteAllLines($p,$l,(New-Object Text.UTF8Encoding($false)))"
exit /b 0

rem :migrate <worktree> <database url>
rem setlocal scopes the explicit DATABASE_URL to this call.
:migrate
setlocal
set "DATABASE_URL=%~2"
pushd "%~1\packages\shared"
call npx prisma migrate deploy
set "RC=%errorlevel%"
popd
endlocal & exit /b %RC%

rem :write_brief <stream> <worktree>
:write_brief
set "TPL=%REPO%\scripts\briefs\%~1.md"
if not exist "%TPL%" (
  echo   [skip] no brief template at scripts\briefs\%~1.md
  exit /b 0
)
powershell -NoProfile -Command "$t=[IO.File]::ReadAllText('%TPL%');$t=$t.Replace('{{STREAM}}','%~1').Replace('{{BRANCH}}','!%~1_BRANCH!').Replace('{{DATABASE}}','!%~1_DB!').Replace('{{REDIS_DB}}','!%~1_REDIS!').Replace('{{COORDINATOR}}','%DW_COORDINATOR%');[IO.File]::WriteAllText('%~2\BRIEF.md',$t,(New-Object Text.UTF8Encoding($false)))"
exit /b 0

rem :write_launcher <stream> <worktree>
:write_launcher
> "%~2\.claude-start.cmd" echo @echo off
>>"%~2\.claude-start.cmd" echo rem Written by dev_worktrees.bat. Starts this stream's Claude.
>>"%~2\.claude-start.cmd" echo title claude: %~1
>>"%~2\.claude-start.cmd" echo cd /d "%%~dp0"
>>"%~2\.claude-start.cmd" echo claude "Read BRIEF.md in this directory and follow it."
exit /b 0

rem :add_exclude <worktree>
rem Keeps BRIEF.md and the launcher out of git status without touching
rem the tracked .gitignore. Each worktree has its own exclude file.
:add_exclude
set "EXCL="
pushd "%~1"
for /f "usebackq delims=" %%g in (`git rev-parse --git-path info/exclude`) do set "EXCL=%%g"
if defined EXCL (
  findstr /x /c:"/BRIEF.md" "!EXCL!" >nul 2>nul
  if errorlevel 1 echo /BRIEF.md>>"!EXCL!"
  findstr /x /c:"/.claude-start.cmd" "!EXCL!" >nul 2>nul
  if errorlevel 1 echo /.claude-start.cmd>>"!EXCL!"
)
popd
exit /b 0
