function htr --argument-names command workspace_id label
    if test -z "$command"
        echo "usage: htr <command> [workspace_id] [label]"
        return 1
    end

    if test -z "$label"
        set label "$command"
    end

    if test -z "$workspace_id"
        set workspace_id (herdr pane list 2>/dev/null | jq -r '.result.panes[] | select(.focused == true) | .workspace_id')
    end

    if test -z "$workspace_id"
        echo "error: could not determine workspace_id and none provided"
        return 1
    end

    set -l pane (herdr tab create --workspace $workspace_id --label "$label" | jq -r '.result.root_pane.pane_id')
    herdr pane run $pane "$command"
end
