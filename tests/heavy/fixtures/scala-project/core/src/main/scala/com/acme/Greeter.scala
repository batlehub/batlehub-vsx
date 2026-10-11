package com.acme

class Greeter(punctuation: String = "!"):
  def greet(name: String): String = s"Hello, $name$punctuation"
