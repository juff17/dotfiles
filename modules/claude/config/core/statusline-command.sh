#!/bin/bash
# Claude Code status line
# Shows: repo, folder, branch, model (gray), context usage (color-coded)

input=$(cat)

# --- Extract values from JSON ---
cwd=$(echo "$input"      | jq -r '.workspace.current_dir // .cwd // empty')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
model=$(echo "$input"    | jq -r '.model.display_name // empty')

# --- Current folder (basename of cwd) ---
folder=""
[ -n "$cwd" ] && folder=$(basename "$cwd")

# --- Repo (owner/name from git remote, else toplevel dir basename) ---
repo=""
if [ -n "$cwd" ]; then
    remote=$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" config --get remote.origin.url 2>/dev/null)
    if [ -n "$remote" ]; then
        # strip protocol, trailing .git, and host -> owner/name
        repo=$(echo "$remote" | sed -E 's#^(git@|https?://)##; s#:#/#; s#\.git$##' | awk -F/ '{print $(NF-1)"/"$NF}')
    fi
    if [ -z "$repo" ]; then
        top=$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
        [ -n "$top" ] && repo=$(basename "$top")
    fi
fi

# --- Git branch ---
branch=""
if [ -n "$cwd" ]; then
    branch=$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" branch --show-current 2>/dev/null)
fi

# --- ANSI palette ---
RESET='\e[0m'
DIM='\e[90m'        # gray  — separator and <10% ctx
YELLOW='\e[38;2;255;255;0m'   # #FFFF00
ORANGE='\e[38;2;255;165;0m'   # #FFA500
RED='\e[38;2;255;0;0m'        # #FF0000
CYAN='\e[36m'
GREEN='\e[32m'

# --- Separator helper ---
_first=true
sep() {
    if [ "$_first" = true ]; then
        _first=false
    else
        printf "${DIM} | ${RESET}"
    fi
}

# --- Repo (with current folder shown alongside it) ---
if [ -n "$repo" ]; then
    sep
    printf "${CYAN}%s${RESET}" "$repo"
    if [ -n "$folder" ]; then
        printf "${DIM} 📁 %s${RESET}" "$folder"
    fi
elif [ -n "$folder" ]; then
    sep
    printf "${DIM}📁 %s${RESET}" "$folder"
fi

# --- Branch ---
if [ -n "$branch" ]; then
    sep
    printf "${GREEN}🌿 %s${RESET}" "$branch"
fi

# --- Model (gray) ---
if [ -n "$model" ]; then
    sep
    printf "${DIM}%s${RESET}" "$model"
fi

# --- Context window (color by used %) ---
if [ -n "$used_pct" ]; then
    pct_int=$(printf "%.0f" "$used_pct")

    if   [ "$pct_int" -lt 10 ]; then color="$DIM"      # <10%  gray
    elif [ "$pct_int" -lt 30 ]; then color="$YELLOW"   # 10-29 yellow
    elif [ "$pct_int" -lt 60 ]; then color="$ORANGE"   # 30-59 orange
    else                              color="$RED"      # 60+   red
    fi

    sep
    printf "${color}%d%%${RESET}" "$pct_int"
fi

printf "\n"
