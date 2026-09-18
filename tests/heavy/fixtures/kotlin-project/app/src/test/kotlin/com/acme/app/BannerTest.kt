package com.acme.app

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class BannerTest {
    @Test
    fun `the banner shouts the greeting`() {
        assertEquals("HELLO, WORLD!", Banner.banner("world"))
    }
}
