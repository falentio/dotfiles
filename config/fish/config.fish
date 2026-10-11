if status is-interactive
    # Commands to run in interactive sessions can go here
end
set -gx PATH "$HOME/.local/venv/bin" $PATH

# opencode
fish_add_path /home/kevin/.opencode/bin
fish_add_path /home/kevin/.pi/agent/bin

# bun
set --export BUN_INSTALL "$HOME/.bun"
set --export PATH $BUN_INSTALL/bin $PATH


set -gx PATH "/home/kevin/.fly/bin" $PATH
set -gx PATH "/opt/nvim-linux-x86_64/bin" $PATH

# pnpm
set -gx PNPM_HOME "/home/kevin/.local/share/pnpm"
if not string match -q -- $PNPM_HOME $PATH
  set -gx PATH "$PNPM_HOME" $PATH
end
# pnpm end
source /home/kevin/.config/fish/daytona.completion_script.fish

# >>> grok installer >>>
fish_add_path $HOME/.grok/bin
# <<< grok installer <<<
