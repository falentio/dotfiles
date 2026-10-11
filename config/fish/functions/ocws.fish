function ocws --description 'Create a herdr workspace at the cwd resolved via zoxide'
    set -l query $argv[1]
    if test -z "$query"
        echo "usage: ocws <zoxide-query>" >&2
        return 1
    end

    set -l cwd (zoxide query $query)
    if test -z "$cwd"
        echo "error: zoxide query '$query' returned nothing" >&2
        return 1
    end

    herdr workspace create --cwd $cwd $argv[2..-1]
end
