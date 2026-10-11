package com.acme.app

import com.acme.Greeter

object Main:
  def main(args: Array[String]): Unit = println(Util.banner(Greeter().greet("app")))
