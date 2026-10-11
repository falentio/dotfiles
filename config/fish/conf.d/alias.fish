function mkrepo
    z Repositories
    mkdir $argv
    z $argv
    git init
    cursor .
end

function zc
    echo $argv[1]
    z $argv[1]
    cursor .
end

function cursor
    nohup  ~/Downloads/Cursor-1.1.3-x86_64.AppImage --no-sandbox $argv > /dev/null 2>&1 &
end

systemctl --user enable podman.socket
systemctl --user start podman.socket
set -g  DOCKER_HOST unix:///run/user/$(id -u)/podman/podman.sock

alias gcam="git commit -am"
alias gpo="git push origin"
