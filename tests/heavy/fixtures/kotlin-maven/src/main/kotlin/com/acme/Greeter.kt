package com.acme

class Greeter(private val punctuation: String = "!") {
    fun greet(name: String): String = "Hello, $name$punctuation"
}
