function opencode-svc-restart --description 'Restart opencode-web systemd user service'
    echo "Restarting opencode-web.service..."
    systemctl --user restart opencode-web
    set -l ec $status
    if test $ec -ne 0
        echo "Failed to restart opencode-web.service (exit $ec)" >&2
        return $ec
    end
    echo "✓ opencode-web.service restarted"
    systemctl --user status opencode-web --no-pager | head -n 20
end
