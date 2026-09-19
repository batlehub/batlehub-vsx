package com.acme.app

import com.acme.Greeter

// The Kotlin half of the mixed module: called from Main.java.
object Banner {
    @JvmStatic
    fun banner(name: String): String = Greeter().greet(name).uppercase()
}
