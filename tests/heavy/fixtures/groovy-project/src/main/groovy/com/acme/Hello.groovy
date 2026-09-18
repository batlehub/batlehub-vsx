package com.acme

class Hello {
    String name = 'world'

    String greet() {
        return "Hello, ${name}!"
    }

    static void main(String[] args) {
        println new Hello().greet()
    }
}
