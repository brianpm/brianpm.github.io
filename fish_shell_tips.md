# FISH shell tips

## PATH

Adding and removing elements from FISH's path is really done by modifying a variable called `fish_user_paths`. 

### Add to PATH
Simply use the command [`fish_add_path`](https://fishshell.com/docs/current/cmds/fish_add_path.html). Use `-v` to see the `set` command that is actually used, and then `echo $fish_user_paths | tr " " "\n" | nl` to see the current user-defined paths (i.e., make sure the new addition is included).

### Remove from PATH
This answer on StackExchange SuperUser is really useful: [link](https://superuser.com/questions/776008/how-to-remove-a-path-from-path-variable-in-fish).

```
echo $fish_user_paths | tr " " "\n" | nl
set --erase --universal fish_user_paths[number]
```