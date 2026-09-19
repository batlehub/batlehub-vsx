package com.acme.core;

public class Person {
    private String name;
    private int age;
    private final boolean active = true;
    private static int count;

    public Person(String name, int age) {
        this.name = name;
        this.age = age;
        count++;
    }
}
