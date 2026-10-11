# ~/.config/fish/conf.d/theme-zedokai.fish
#
# zedokai-filter-machine theme for the fish shell.
# Replaces the old hardcoded tide universal variables with a single,
# declarative, easily-reversible module.
#
# Uninstall / revert:
#   set -e (set -U --names | string match -r '^tide_.*_color')
#   then re-run `tide configure` (or source your old backup)
#
# Backups of the pre-zedokai state live in:
#   ~/.config/fish/tide-backup/tide-colors-backup-*.fish
#
# Palette (zedokai-filter-machine.json)
#   primary  ffed72   secondary/info 7cd5f1   accent2 baa0f8
#   success  a2e57b   warning         ffb270   error   ff6d7e
#   text     f2fffc   muted           8b9798
#   bg       273136   panel           2d373c   element 3a4449
#   border   414b50   borderActive    6b7678   lineNum 545f62

# Fish only auto-sources conf.d/ in interactive shells, but when this file is
# sourced manually we must not break non-interactive runs. Never abort the
# shell; just skip applying if tide isn't present.

# ---------------------------------------------------------------------------
# Semantic color variables (best practice: name colors, don't scatter hex)
# ---------------------------------------------------------------------------
set -g _zed_primary      ffed72
set -g _zed_secondary    7cd5f1
set -g _zed_accent        baa0f8
set -g _zed_success       a2e57b
set -g _zed_warning       ffb270
set -g _zed_error         ff6d7e
set -g _zed_text          f2fffc
set -g _zed_muted         8b9798
set -g _zed_bg            273136
set -g _zed_panel         2d373c
set -g _zed_element       3a4449
set -g _zed_border        414b50
set -g _zed_border_active 6b7678
set -g _zed_linenum       545f62

# Skip if tide isn't installed. Check the config dir rather than a function,
# so this works whether or not functions are autoloaded.
test -d $__fish_config_dir/functions/tide; or return

# ---------------------------------------------------------------------------
# Prompt frame & separators — match kitty borders
# ---------------------------------------------------------------------------
set -U tide_prompt_color_frame_and_connection  $_zed_border
set -U tide_prompt_color_separator_same_color  $_zed_border_active

# ---------------------------------------------------------------------------
# pwd — element panel, readable text, info-colored anchors
# ---------------------------------------------------------------------------
set -U tide_pwd_bg_color                $_zed_element
set -U tide_pwd_color_dirs              $_zed_text
set -U tide_pwd_color_anchors           $_zed_secondary
set -U tide_pwd_color_truncated_dirs    $_zed_muted

# ---------------------------------------------------------------------------
# git — success / warning / urgent (dark text on light bgs = good contrast)
# ---------------------------------------------------------------------------
set -U tide_git_bg_color          $_zed_success
set -U tide_git_bg_color_unstable $_zed_warning
set -U tide_git_bg_color_urgent   $_zed_error
set -U tide_git_color_branch      $_zed_bg
set -U tide_git_color_conflicted  $_zed_bg
set -U tide_git_color_dirty       $_zed_bg
set -U tide_git_color_operation   $_zed_bg
set -U tide_git_color_staged      $_zed_bg
set -U tide_git_color_stash       $_zed_bg
set -U tide_git_color_untracked   $_zed_bg
set -U tide_git_color_upstream    $_zed_bg

# ---------------------------------------------------------------------------
# status — success bg / error bg, contrasting text
# ---------------------------------------------------------------------------
set -U tide_status_bg_color          $_zed_panel
set -U tide_status_bg_color_failure  $_zed_error
set -U tide_status_color             $_zed_success
set -U tide_status_color_failure     $_zed_bg

# ---------------------------------------------------------------------------
# character
# ---------------------------------------------------------------------------
set -U tide_character_color          $_zed_success
set -U tide_character_color_failure  $_zed_error

# ---------------------------------------------------------------------------
# Secondary items on the panel background (terminal-friendly, low contrast risk)
# ---------------------------------------------------------------------------
set -U tide_os_bg_color            $_zed_panel
set -U tide_os_color               $_zed_primary
set -U tide_jobs_bg_color          $_zed_panel
set -U tide_jobs_color             $_zed_success
set -U tide_python_bg_color        $_zed_panel
set -U tide_python_color           $_zed_secondary
set -U tide_context_bg_color       $_zed_panel
set -U tide_context_color_default  $_zed_muted
set -U tide_context_color_root     $_zed_warning
set -U tide_context_color_ssh      $_zed_secondary

# ---------------------------------------------------------------------------
# cmd_duration & time
# ---------------------------------------------------------------------------
set -U tide_cmd_duration_bg_color  $_zed_warning
set -U tide_cmd_duration_color     $_zed_bg
set -U tide_time_bg_color          $_zed_element
set -U tide_time_color             $_zed_text

# ---------------------------------------------------------------------------
# Tool/language items — keep neutral `normal` backgrounds so the kitty theme
# shows through. Only tint the icon/text color. (Avoids the contrast trap.)
# ---------------------------------------------------------------------------
for _zed_item in node go rustc java ruby php crystal elixir zig kubectl \
                 docker aws gcloud nix_shell pulumi terraform toolbox \
                 distrobox private_mode shlvl direnv
    set -U tide_{$_zed_item}_bg_color normal
end

set -U tide_node_color       $_zed_success
set -U tide_go_color         $_zed_secondary
set -U tide_rustc_color      $_zed_warning
set -U tide_java_color       $_zed_warning
set -U tide_ruby_color       $_zed_error
set -U tide_php_color        $_zed_accent
set -U tide_crystal_color    $_zed_accent
set -U tide_elixir_color     $_zed_accent
set -U tide_zig_color        $_zed_warning
set -U tide_kubectl_color    $_zed_secondary
set -U tide_docker_color     $_zed_secondary
set -U tide_aws_color        $_zed_warning
set -U tide_gcloud_color     $_zed_secondary
set -U tide_nix_shell_color  $_zed_accent
set -U tide_pulumi_color     $_zed_warning
set -U tide_terraform_color  $_zed_accent
set -U tide_toolbox_color    $_zed_text
set -U tide_distrobox_color  $_zed_accent
set -U tide_private_mode_color $_zed_muted
set -U tide_shlvl_color      $_zed_text
set -U tide_direnv_color        $_zed_warning
set -U tide_direnv_color_denied $_zed_error
set -U tide_direnv_bg_color_denied normal

# ---------------------------------------------------------------------------
# vi_mode
# ---------------------------------------------------------------------------
set -U tide_vi_mode_color_default  $_zed_text
set -U tide_vi_mode_color_insert   $_zed_bg
set -U tide_vi_mode_color_replace  $_zed_bg
set -U tide_vi_mode_color_visual   $_zed_bg
set -U tide_vi_mode_bg_color_default $_zed_linenum
set -U tide_vi_mode_bg_color_insert  $_zed_secondary
set -U tide_vi_mode_bg_color_replace $_zed_success
set -U tide_vi_mode_bg_color_visual  $_zed_warning
