package com.acme

import spock.lang.Specification

class HelloSpec extends Specification {
    def "greets the world"() {
        expect:
        new Hello().greet() == 'Hello, world!'
    }
}
