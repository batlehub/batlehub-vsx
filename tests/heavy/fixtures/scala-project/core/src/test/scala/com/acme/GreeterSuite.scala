package com.acme

class GreeterSuite extends munit.FunSuite:
  test("greets") {
    assertEquals(Greeter().greet("Ada"), "Hello, Ada!")
  }
