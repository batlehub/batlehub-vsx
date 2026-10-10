package com.acme.core;

import java.util.List;

public final class CustomerBuilder {
    String name;
    int age;
    String id;
    List<String> tags;

    CustomerBuilder() {
    }

    public CustomerBuilder name(String name) {
        this.name = name;
        return this;
    }

    public CustomerBuilder age(int age) {
        this.age = age;
        return this;
    }

    public CustomerBuilder id(String id) {
        this.id = id;
        return this;
    }

    public CustomerBuilder tags(List<String> tags) {
        this.tags = tags;
        return this;
    }

    public Customer build() {
        return new Customer(this);
    }
}
