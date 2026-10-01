// Sin consola extra en release de Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    apuntador_lib::run()
}
